const fs = require('fs');
const path = require('path');
const config = require('../config');
const { logger } = require('../utils/logger');
const { ensurePathWithinBase } = require('../utils/sanitize');
const { supabase } = require('./supabase');
const { createLockProvider } = require('../utils/lock');
const { getRedisConnection } = require('../utils/redis-connection');
const { findProjectFolderRecursive } = require('./downloader');

const lockProvider = (function createProvider() {
  if (config.LOCK_PROVIDER === 'redis') {
    return createLockProvider('redis', getRedisConnection());
  }
  return createLockProvider('memory');
})();

const MAX_WALK_DEPTH = 50;

/**
 * Cuenta el número de archivos y el tamaño total de un directorio de forma recursiva.
 * @param {string} dirPath Ruta absoluta del directorio a escanear
 * @returns {Promise<{fileCount: number, totalSize: number}>}
 */
async function countFilesRecursive(dirPath) {
  let fileCount = 0;
  let totalSize = 0;

  async function walk(currentPath, depth) {
    if (depth > MAX_WALK_DEPTH) {
      logger.warn(`[FolderMover] Profundidad máxima (${MAX_WALK_DEPTH}) alcanzada en "${currentPath}". Saltando subdirectorios.`);
      return;
    }
    const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        fileCount++;
        try {
          const stat = await fs.promises.stat(fullPath);
          totalSize += stat.size;
        } catch {
          fileCount--;
        }
      }
    }
  }

  await walk(dirPath, 0);
  return { fileCount, totalSize };
}

/**
 * Mueve un directorio a la papelera (.trash) dentro de la ruta base con marca de tiempo.
 * @param {string} dirPath Ruta absoluta del directorio a mover
 * @param {string} basePath Ruta base donde se crea el directorio .trash
 * @returns {Promise<string>} Ruta absoluta del directorio en la papelera
 */
async function moveToTrash(dirPath, basePath) {
  const trashDir = path.join(basePath, '.trash');
  await fs.promises.mkdir(trashDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dirName = path.basename(dirPath);
  const trashPath = path.join(trashDir, `${dirName}_${timestamp}`);

  await fs.promises.rename(dirPath, trashPath);
  logger.info(`[FolderMover] Carpeta movida a papelera: "${dirPath}" → "${trashPath}"`);
  return trashPath;
}

/**
 * Mueve la carpeta de un proyecto desde 1ACTIVOS a TERMINADOS en el servidor de archivos.
 * 
 * @param {string} jobId ID del trabajo
 * @param {string} jobTitle Título del trabajo (se usa para extraer el código Pxxxxx)
 * @returns {Promise<{moved: boolean, source?: string, destination?: string, reason?: string}>}
 */
async function moveJobToTerminados(jobId, jobTitle) {
  logger.info(`[FolderMover] Iniciando traslado de carpeta para Job ${jobId} ("${jobTitle}")`);

  try {
    const { data: job, error: jobError } = await supabase
      .from('jobs')
      .select('downloaded_at')
      .eq('id', jobId)
      .single();

    if (jobError) throw jobError;
    if (!job) throw new Error(`El Job ${jobId} no existe en la base de datos.`);

    if (!job.downloaded_at) {
      throw new Error(
        `[FolderMover] El Job ${jobId} no ha sido descargado aún (downloaded_at es null). ` +
        `No se puede mover a TERMINADOS hasta que la descarga se complete.`
      );
    }
    logger.info(`[FolderMover] Job ${jobId} verificado como descargado (${job.downloaded_at}).`);
  } catch (err) {
    if (err.message && err.message.includes('no ha sido descargado')) {
      throw err;
    }
    logger.error(`[FolderMover] Error al verificar estado de descarga del Job ${jobId}:`, err.message);
    throw err;
  }

  const trimmedTitle = jobTitle.trim();
  const match = trimmedTitle.match(/^(P\d+)/i);
  if (!match) {
    throw new Error(`El título del trabajo "${trimmedTitle}" no contiene un código de proyecto válido (Pxxxxx)`);
  }

  const projectCode = match[1].toUpperCase();
  const activosPath = path.join(config.TRABAJOS_BASE_PATH, '1ACTIVOS');
  const terminadosPath = path.join(config.TRABAJOS_BASE_PATH, 'TERMINADOS');

  let smbMounted = false;
  try {
    await fs.promises.access(activosPath);
    smbMounted = true;
  } catch {
    smbMounted = false;
  }

  if (!smbMounted) {
    logger.warn(`[FolderMover] El directorio 1ACTIVOS no existe en "${activosPath}". Cancelando traslado.`);
    return { moved: false, reason: 'activos_dir_not_found' };
  }

  let sourceFullPath = null;
  try {
    sourceFullPath = await findProjectFolderRecursive(activosPath, projectCode, 0, 4);
  } catch (err) {
    throw new Error(`Error buscando directorio activo para traslado: ${err.message}`);
  }

  if (!sourceFullPath) {
    logger.warn(`[FolderMover] No se encontró ninguna carpeta activa para el código "${projectCode}" en "${activosPath}".`);
    return { moved: false, reason: 'project_folder_not_found' };
  }

  const sourceDirName = path.basename(sourceFullPath);

  let terminadosExists = false;
  try {
    await fs.promises.access(terminadosPath);
    terminadosExists = true;
  } catch {
    terminadosExists = false;
  }

  if (!terminadosExists) {
    logger.info(`[FolderMover] Creando carpeta raíz TERMINADOS: "${terminadosPath}"`);
    await fs.promises.mkdir(terminadosPath, { recursive: true });
  }

  await lockProvider.acquire(`move:${projectCode}`, 60000);
  try {
    let targetDirName = sourceDirName;
    let targetFullPath = path.join(terminadosPath, targetDirName);
    let collisionCounter = 1;

    while (await fs.promises.access(targetFullPath).then(() => true).catch(() => false)) {
      collisionCounter++;
      if (collisionCounter > config.MAX_COLLISIONS) {
        throw new Error(
          `Se superó el límite de ${config.MAX_COLLISIONS} colisiones al buscar nombre disponible en TERMINADOS para "${sourceDirName}". ` +
          `Posible bucle infinito o acumulación excesiva de versiones.`
        );
      }
      targetDirName = `${sourceDirName}_v${collisionCounter}`;
      targetFullPath = path.join(terminadosPath, targetDirName);
    }

    if (collisionCounter > 1) {
      logger.warn(`[FolderMover] Colisión detectada. La carpeta ya existe en destino. Renombrando traslado a: "${targetDirName}"`);
    }

    try {
      ensurePathWithinBase(sourceFullPath, config.TRABAJOS_BASE_PATH);
      ensurePathWithinBase(targetFullPath, config.TRABAJOS_BASE_PATH);
    } catch (err) {
      logger.error(`[FolderMover] Error de seguridad validando rutas para Job ${jobId}:`, err.message);
      throw err;
    }

    try {
      logger.info(`[FolderMover] Trasladando de "${sourceFullPath}" a "${targetFullPath}"`);

      await fs.promises.rename(sourceFullPath, targetFullPath);

      logger.info(`[FolderMover] Traslado completado con éxito para el proyecto "${projectCode}"`);
      return { moved: true, source: sourceFullPath, destination: targetFullPath };
    } catch (err) {
      if (err.code === 'EXDEV') {
        logger.warn(`[FolderMover] Traslado directo no permitido (EXDEV). Ejecutando fallback de copia y borrado...`);
        try {
          await fs.promises.cp(sourceFullPath, targetFullPath, { recursive: true });

          const sourceStats = await countFilesRecursive(sourceFullPath);
          const destStats = await countFilesRecursive(targetFullPath);

          if (sourceStats.fileCount !== destStats.fileCount || sourceStats.totalSize !== destStats.totalSize) {
            logger.error(
              `[FolderMover] Verificación de integridad FALLIDA tras copia EXDEV para Job ${jobId}. ` +
              `Origen: ${sourceStats.fileCount} archivos (${sourceStats.totalSize} bytes), ` +
              `Destino: ${destStats.fileCount} archivos (${destStats.totalSize} bytes). ` +
              `NO se eliminará el origen. Se eliminará la copia incompleta del destino.`
            );
            await fs.promises.rm(targetFullPath, { recursive: true, force: true });
            throw new Error(
              `Integridad comprometida tras copia EXDEV: origen tiene ${sourceStats.fileCount} archivos ` +
              `(${sourceStats.totalSize} bytes) pero destino tiene ${destStats.fileCount} archivos ` +
              `(${destStats.totalSize} bytes). Operación abortada, destino eliminado.`
            );
          }

          logger.info(
            `[FolderMover] Integridad verificada: ${sourceStats.fileCount} archivos, ` +
            `${sourceStats.totalSize} bytes coinciden entre origen y destino.`
          );

          const filesInSource = await fs.promises.readdir(sourceFullPath, { recursive: true });
          logger.warn(
            `[FolderMover] Moviendo a papelera (en lugar de eliminar definitivamente). ` +
            `Carpeta: "${sourceFullPath}". Contenido (${filesInSource.length} entradas): ` +
            `${filesInSource.slice(0, 20).join(', ')}${filesInSource.length > 20 ? '...' : ''}`
          );

          await moveToTrash(sourceFullPath, config.TRABAJOS_BASE_PATH);

          logger.info(`[FolderMover] Traslado con copia + papelera completado con éxito.`);
          return { moved: true, source: sourceFullPath, destination: targetFullPath };
        } catch (copyErr) {
          logger.error(`[FolderMover] Error crítico en el fallback de copia para Job ${jobId}:`, copyErr.message);
          throw copyErr;
        }
      } else {
        logger.error(`[FolderMover] Error al renombrar directorio del Job ${jobId}:`, err.message);
        throw err;
      }
    }
  } finally {
    await lockProvider.release(`move:${projectCode}`);
  }
}

module.exports = {
  moveJobToTerminados
};
