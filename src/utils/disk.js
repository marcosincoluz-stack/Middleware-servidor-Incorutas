const fs = require('fs');
const config = require('../config');
const { logger } = require('./logger');

/**
 * Comprueba el espacio en disco disponible en la ruta especificada.
 * Utiliza la función nativa fs.promises.statfs (disponible en Node.js 18.15+)
 * para consultar de manera eficiente la información del sistema de archivos sin spawnear procesos del sistema.
 * 
 * @param {string} targetPath Ruta a comprobar (por defecto la ruta base de trabajos)
 * @returns {Promise<{freeMB: number, isSafe: boolean}>} Espacio libre en MB y flag indicando si es seguro continuar
 */
async function checkDiskSpace(targetPath = config.TRABAJOS_BASE_PATH, timeoutMs = 5000) {
  let timer;
  try {
    const statfsPromise = fs.promises.statfs(targetPath);
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timeout statfs tras ${timeoutMs}ms`)), timeoutMs);
    });

    const stats = await Promise.race([statfsPromise, timeoutPromise]);

    const freeBytes = stats.bavail * stats.bsize;
    const freeMB = freeBytes / (1024 * 1024);

    const isSafe = freeMB >= config.MIN_DISK_MB;

    if (!isSafe) {
      logger.error(`¡ESPACIO EN DISCO CRÍTICO! Ruta: "${targetPath}". Libre: ${freeMB.toFixed(2)} MB. Mínimo requerido: ${config.MIN_DISK_MB} MB.`);
    } else {
      logger.debug(`Espacio en disco para "${targetPath}": ${freeMB.toFixed(2)} MB disponibles.`);
    }

    return {
      freeMB,
      isSafe
    };
  } catch (err) {
    logger.error(`Error de E/S al comprobar el espacio de disco en "${targetPath}":`, err.message);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  checkDiskSpace
};
