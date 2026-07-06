const fs = require('fs');
const path = require('path');
const config = require('../config');
const { supabase } = require('./supabase');
const { logger } = require('../utils/logger');
const { ensurePathWithinBase, sanitizeFilename } = require('../utils/sanitize');
const { createLockProvider } = require('../utils/lock');
const { getRedisConnection } = require('../utils/redis-connection');
const { findProjectFolderRecursive, shouldScanDirectory } = require('./downloader');
const { metricsTracker } = require('../jobs/metrics-tracker');
const notify = require('../utils/notify');

const lockProvider = (function createProvider() {
  if (config.LOCK_PROVIDER === 'redis') {
    return createLockProvider('redis', getRedisConnection());
  }
  return createLockProvider('memory');
})();

const SUPABASE_QUERY_TIMEOUT_MS = 10000;
const STORAGE_UPLOAD_TIMEOUT_MS = 30000;
const STORAGE_EXISTS_TIMEOUT_MS = 10000;
const FABRICACION_READDIR_TIMEOUT_MS = 5000;
const PDF_MAGIC = '%PDF-';
const PDF_EOF = '%%EOF';

/**
 * Normaliza un string a ASCII eliminando acentos/diacríticos.
 * Supabase Storage rechaza keys con caracteres no-ASCII (RÓTULO -> Invalid key).
 * Ej: "QUIRÓN PREVENCIÓN" -> "QUIRON PREVENCION", "SABIÑANIGO" -> "SABINANIGO".
 *
 * @param {string} str Texto a normalizar
 * @returns {string} Texto solo-ASCII
 */
function normalizeAscii(str) {
  if (typeof str !== 'string') return '';
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function withTimeout(promise, ms) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout tras ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

/**
 * Parsea el campo plans_url de la BD a un array de entradas {name, path}.
 * - null/vacío → []
 * - string que empieza por '[' → JSON.parse (fallback [] si corrupto)
 * - string suelto (legacy) → [{name: null, path: <string>}]
 *
 * @param {string|null} plansUrl Valor crudo de la columna plans_url
 * @returns {Array<{name: string|null, path: string}>}
 */
function parsePlansUrl(plansUrl) {
  if (!plansUrl || typeof plansUrl !== 'string') return [];
  const trimmed = plansUrl.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      if (!Array.isArray(arr)) return [];
      return arr.map(e => {
        if (typeof e === 'string') return { name: null, path: e };
        return { name: e && typeof e.name === 'string' ? e.name : null, path: e && typeof e.path === 'string' ? e.path : '' };
      }).filter(e => e.path);
    } catch {
      logger.warn(`[PlanoUploader] plans_url corrupto, tratando como vacío: ${trimmed.slice(0, 80)}...`);
      return [];
    }
  }
  return [{ name: null, path: trimmed }];
}

/**
 * Resuelve la carpeta FABRICACION (o subcarpeta configurada) de un proyecto
 * buscándola en 1ACTIVOS y, si no aparece, en TERMINADOS (fallback para jobs ya movidos).
 *
 * @param {string} jobTitle Título del trabajo (debe empezar por Pxxxxx)
 * @returns {Promise<string|null>} Ruta absoluta de la carpeta FABRICACION, o null si no existe
 */
async function resolveFabricacionFolder(jobTitle) {
  const trimmedTitle = (jobTitle || '').trim();
  const match = trimmedTitle.match(/^(P\d+)/i);
  if (!match) {
    throw new Error(`El título del trabajo "${trimmedTitle}" no comienza con un código de proyecto válido (Pxxxxx)`);
  }

  const projectCode = match[1].toUpperCase();
  const subfolder = config.PLANO_SCAN_SUBFOLDER;
  const maxDepth = config.PROJECT_FOLDER_MAX_DEPTH;

  const roots = [
    path.join(config.TRABAJOS_BASE_PATH, '1ACTIVOS'),
    path.join(config.TRABAJOS_BASE_PATH, 'TERMINADOS')
  ];

  for (const root of roots) {
    try {
      await fs.promises.access(root);
    } catch {
      continue;
    }

    const projectFolder = await findProjectFolderRecursive(root, projectCode, 0, maxDepth);
    if (projectFolder) {
      const fabricacionPath = path.join(projectFolder, subfolder);
      try {
        await fs.promises.access(fabricacionPath);
        return ensurePathWithinBase(fabricacionPath, config.TRABAJOS_BASE_PATH);
      } catch {
        logger.debug(`[PlanoUploader] Carpeta "${subfolder}" no encontrada en proyecto ${projectCode} (${root}).`);
      }
    }
  }

  return null;
}

/**
 * Lista los PDFs en el nivel top de FABRICACION cuyo nombre empieza por el P-code
 * del proyecto (case-insensitive). NO recursivo.
 *
 * @param {string} fabricacionPath Ruta absoluta de la carpeta FABRICACION
 * @param {string} projectCode Código del proyecto (ej: P260251)
 * @returns {Promise<Array<{name: string}>>} Lista de PDFs que matchean
 */
async function listMatchingPdfs(fabricacionPath, projectCode) {
  let entries;
  try {
    entries = await withTimeout(
      fs.promises.readdir(fabricacionPath, { withFileTypes: true }),
      FABRICACION_READDIR_TIMEOUT_MS
    );
  } catch (err) {
    logger.debug(`[PlanoUploader] No se pudo leer FABRICACION "${fabricacionPath}": ${err.message}`);
    return [];
  }

  const prefix = projectCode.toUpperCase();
  return entries
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.pdf') && e.name.toUpperCase().startsWith(prefix))
    .map(e => ({ name: e.name }));
}

/**
 * Lista todos los PDFs en el nivel top de una carpeta (NO recursivo, sin filtro de P-code).
 * Mantenido para compatibilidad/uso general.
 *
 * @param {string} fabricacionPath Ruta absoluta de la carpeta
 * @returns {Promise<Array<{name: string}>>} Lista de entradas PDF
 */
async function listTopLevelPdfs(fabricacionPath) {
  let entries;
  try {
    entries = await fs.promises.readdir(fabricacionPath, { withFileTypes: true });
  } catch (err) {
    logger.debug(`[PlanoUploader] No se pudo leer FABRICACION "${fabricacionPath}": ${err.message}`);
    return [];
  }

  return entries
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.pdf'))
    .map(e => ({ name: e.name }));
}

/**
 * De los PDFs nuevos encontrados, selecciona cuántos subir respetando el máximo
 * total por job (PLANO_MAX_PLANOS_PER_JOB). Orden alfabético.
 * Alerta por Telegram si hay PDFs que se omiten por exceder el máximo.
 *
 * @param {Array<{name: string}>} newPdfs PDFs nuevos detectados
 * @param {number} alreadyUploadedCount Planos ya subidos para el job
 * @param {string} jobId ID del trabajo (para alerta)
 * @param {string} title Título del trabajo (para alerta)
 * @returns {Promise<Array<{name: string}>>} PDFs seleccionados para subir
 */
async function selectPlanoPdfs(newPdfs, alreadyUploadedCount, jobId, title) {
  if (newPdfs.length === 0) return [];

  const maxTotal = config.PLANO_MAX_PLANOS_PER_JOB;
  const slotsAvailable = Math.max(0, maxTotal - alreadyUploadedCount);

  if (slotsAvailable === 0) {
    logger.warn(`[PlanoUploader] Job ${jobId}: máximo de ${maxTotal} planos ya alcanzado. ${newPdfs.length} nuevos omitidos.`);
    await notify.alertMultiplePlanos(jobId, title, newPdfs.length, 0, newPdfs.length, newPdfs.map(p => p.name)).catch(() => {});
    return [];
  }

  const sorted = [...newPdfs].sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
  const selected = sorted.slice(0, slotsAvailable);
  const omitted = sorted.slice(slotsAvailable);

  if (omitted.length > 0) {
    logger.warn(`[PlanoUploader] Job ${jobId}: ${newPdfs.length} planos nuevos, subiendo ${selected.length}, omitidos ${omitted.length} (máximo ${maxTotal}).`);
    await notify.alertMultiplePlanos(jobId, title, newPdfs.length, selected.length, omitted.length, omitted.map(p => p.name)).catch(() => {});
  }

  return selected;
}

/**
 * Valida que un Buffer sea un PDF válido: debe empezar con %PDF- y contener %%EOF.
 *
 * @param {Buffer} buffer Contenido del archivo
 * @throws {Error} Si no es un PDF válido
 */
function validatePdfBuffer(buffer) {
  if (!buffer || buffer.length === 0) {
    throw new Error('El archivo está vacío (0 bytes).');
  }

  const head = buffer.subarray(0, 5).toString('latin1');
  if (head !== PDF_MAGIC) {
    throw new Error(`El archivo no es un PDF válido: no empieza con "${PDF_MAGIC}" (encontrado: "${head}").`);
  }

  const tail = buffer.subarray(-1024).toString('latin1');
  if (!tail.includes(PDF_EOF)) {
    throw new Error(`El PDF está truncado o incompleto: no se encontró "${PDF_EOF}" en el final.`);
  }
}

/**
 * Sube un PDF al bucket de planos y verifica que el objeto existe.
 * El objeto se nombra planos_<jobId>_<nombre_saneado>.pdf (upsert para re-subidas).
 *
 * @param {string} jobId ID del trabajo
 * @param {string} pdfName Nombre original del PDF
 * @param {string} fabricacionPath Carpeta FABRICACION (para path traversal check)
 * @returns {Promise<{name: string, path: string}>} Entrada {name, path} para el array
 */
async function uploadPlanoToStorage(jobId, pdfName, fabricacionPath) {
  const filePath = path.join(fabricacionPath, pdfName);
  ensurePathWithinBase(filePath, fabricacionPath);

  const stat = await fs.promises.stat(filePath);
  const maxBytes = config.PLANO_MAX_SIZE_MB * 1024 * 1024;
  if (stat.size > maxBytes) {
    throw new Error(`El plano "${pdfName}" excede el límite de ${config.PLANO_MAX_SIZE_MB} MB (${(stat.size / 1024 / 1024).toFixed(2)} MB).`);
  }

  const buffer = await fs.promises.readFile(filePath);
  validatePdfBuffer(buffer);

  const storagePath = `planos_${jobId}_${normalizeAscii(sanitizeFilename(pdfName))}`;

  logger.info(`[PlanoUploader] Subiendo "${pdfName}" (${(stat.size / 1024).toFixed(1)} KB) a ${config.SUPABASE_PLANOS_BUCKET}/${storagePath}`);

  const { error: uploadError } = await withTimeout(
    supabase.storage
      .from(config.SUPABASE_PLANOS_BUCKET)
      .upload(storagePath, buffer, { upsert: true, contentType: 'application/pdf' }),
    STORAGE_UPLOAD_TIMEOUT_MS
  );

  if (uploadError) {
    throw new Error(`Error subiendo plano a Storage: ${uploadError.message}`);
  }

  let existsData = false;
  try {
    const { data, error: existsError } = await withTimeout(
      supabase.storage.from(config.SUPABASE_PLANOS_BUCKET).exists(storagePath),
      STORAGE_EXISTS_TIMEOUT_MS
    );
    existsData = data === true;
    if (existsError) {
      logger.warn(`[PlanoUploader] .exists() devolvió error para ${storagePath}: ${existsError.message}`);
    }
  } catch (err) {
    logger.warn(`[PlanoUploader] No se pudo verificar .exists() para ${storagePath}: ${err.message}`);
  }

  if (!existsData) {
    throw new Error(`Verificación post-subida fallida: el objeto ${storagePath} no existe en el bucket tras la subida.`);
  }

  logger.info(`[PlanoUploader] Plano subido y verificado: ${storagePath}`);
  return { name: pdfName, path: storagePath };
}

/**
 * Reemplaza plans_url en la tabla jobs con el array serializado completo (append).
 * Usa compare-and-swap (CAS): el UPDATE solo afecta la fila si plans_url sigue
 * siendo igual al valor leído al inicio (expectedOldValue). Si otro proceso appendó
 * entretanto, 0 filas afectadas → el caller trata la raza (el polling re-detecta y
 * reintenta en el siguiente ciclo; los objetos ya subidos son idempotentes por upsert).
 *
 * @param {string} jobId ID del trabajo
 * @param {Array<{name: string, path: string}>} plansArray Array completo (viejos + nuevos)
 * @param {string|null} expectedOldValue Valor de plans_url leído al inicio (para CAS)
 * @returns {Promise<boolean>} true si se actualizó, false si CAS falló (raza)
 */
async function updatePlansUrl(jobId, plansArray, expectedOldValue) {
  let query = supabase
    .from('jobs')
    .update({ plans_url: JSON.stringify(plansArray) })
    .eq('id', jobId);

  if (expectedOldValue === null || expectedOldValue === undefined) {
    query = query.is('plans_url', null);
  } else {
    query = query.eq('plans_url', expectedOldValue);
  }

  const { data, error } = await withTimeout(
    query.select('id'),
    SUPABASE_QUERY_TIMEOUT_MS
  );

  if (error) {
    throw new Error(`Error actualizando plans_url para job ${jobId}: ${error.message}`);
  }

  return Array.isArray(data) && data.length > 0;
}

/**
 * Procesa la subida de planos de un job con auto-append:
 * 1. Lee plans_url actual (array de {name, path}).
 * 2. Lista PDFs en FABRICACION que empiezan por el P-code.
 * 3. Diff: encuentra planos nuevos (cuyo name no está en plans_url).
 * 4. Sube los nuevos (respetando PLANO_MAX_PLANOS_PER_JOB total).
 * 5. Append al array y UPDATE.
 *
 * Idempotente vía lock plano:<jobId> + diff por nombre. No re-sube planos ya subidos.
 *
 * @param {string} jobId ID del trabajo
 * @param {string} jobTitle Título del trabajo (para extraer P-code; si vacío, usa el de la BD)
 * @returns {Promise<{skipped?: boolean, reason?: string, uploaded?: number, paths?: string[]}>}
 */
async function processJobPlano(jobId, jobTitle) {
  logger.info(`[PlanoUploader] Iniciando procesado de planos para Job ${jobId} ("${jobTitle}")`);

  const jobLockKey = `plano:${jobId}`;
  try {
    await lockProvider.acquire(jobLockKey, 120000);
  } catch (err) {
    logger.info(`[PlanoUploader] Job ${jobId} ya está siendo procesado (${err.message}). Omitiendo.`);
    return { skipped: true, reason: 'lock_contention' };
  }

  try {
    const { data: job, error: jobError } = await withTimeout(
      supabase
        .from('jobs')
        .select('id, title, plans_url')
        .eq('id', jobId)
        .single(),
      SUPABASE_QUERY_TIMEOUT_MS
    );

    if (jobError) throw jobError;
    if (!job) throw new Error('El Job no existe en la base de datos.');

    const existingPlans = parsePlansUrl(job.plans_url);
    const uploadedNames = new Set(existingPlans.filter(e => e.name).map(e => e.name));
    const alreadyUploadedCount = existingPlans.length;

    if (alreadyUploadedCount >= config.PLANO_MAX_PLANOS_PER_JOB) {
      logger.debug(`[PlanoUploader] Job ${jobId}: máximo de ${config.PLANO_MAX_PLANOS_PER_JOB} planos alcanzado. Sin acción.`);
      return { skipped: true, reason: 'max_reached' };
    }

    const fabricacionPath = await resolveFabricacionFolder(job.title || jobTitle);
    if (!fabricacionPath) {
      logger.debug(`[PlanoUploader] Job ${jobId}: no se encontró carpeta FABRICACION. El plano aún no está listo.`);
      return { skipped: true, reason: 'no_folder' };
    }

    const title = job.title || jobTitle || '';
    const projectMatch = title.trim().match(/^(P\d+)/i);
    if (!projectMatch) {
      throw new Error(`El título del trabajo "${title}" no comienza con un código de proyecto válido (Pxxxxx)`);
    }
    const projectCode = projectMatch[1].toUpperCase();

    const pdfs = await listMatchingPdfs(fabricacionPath, projectCode);
    if (pdfs.length === 0) {
      logger.debug(`[PlanoUploader] Job ${jobId}: FABRICACION sin PDFs que empiecen por ${projectCode}.`);
      return { skipped: true, reason: 'no_pdf' };
    }

    const newPdfs = pdfs.filter(p => !uploadedNames.has(p.name));
    if (newPdfs.length === 0) {
      logger.debug(`[PlanoUploader] Job ${jobId}: todos los planos ya subidos. Sin acción.`);
      return { skipped: true, reason: 'up_to_date' };
    }

    const selected = await selectPlanoPdfs(newPdfs, alreadyUploadedCount, jobId, title);
    if (selected.length === 0) {
      return { skipped: true, reason: 'max_reached' };
    }

    const uploadedEntries = [];
    for (const pdf of selected) {
      const entry = await uploadPlanoToStorage(jobId, pdf.name, fabricacionPath);
      uploadedEntries.push(entry);
    }

    const mergedArray = [...existingPlans, ...uploadedEntries];
    const updated = await updatePlansUrl(jobId, mergedArray, job.plans_url);

    if (!updated) {
      logger.warn(`[PlanoUploader] Job ${jobId}: CAS falló (plans_url fue modificado por otro proceso entre la lectura y el UPDATE). Objetos subidos quedaron en Storage (idempotentes por upsert); el polling re-detectará y reintenta en el siguiente ciclo.`);
      return { skipped: true, reason: 'race_condition_resolved' };
    }

    metricsTracker.addPlanos(uploadedEntries.length);
    logger.info(`[PlanoUploader] Job ${jobId}: ${uploadedEntries.length} plano(s) subido(s) y registrado(s). Total: ${mergedArray.length}.`);
    return { uploaded: uploadedEntries.length, paths: uploadedEntries.map(e => e.path) };
  } finally {
    await lockProvider.release(jobLockKey);
  }
}

/**
 * Construye un índice { P-code → ruta absoluta } de todas las carpetas de proyecto
 * bajo `root` en un solo walk DFS con poda. Reutiliza shouldScanDirectory.
 *
 * @param {string} root Directorio base (ej: 1ACTIVOS)
 * @returns {Promise<Map<string, string>>} Mapa P-code → ruta absoluta
 */
async function buildProjectFolderIndex(root) {
  const index = new Map();
  const maxDepth = config.PROJECT_FOLDER_MAX_DEPTH;

  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      logger.debug(`[PlanoUploader] No se pudo leer "${dir}" para índice: ${err.message}`);
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(dir, entry.name);
      const pMatch = entry.name.match(/^P\d+/i);
      if (pMatch) {
        const pCode = pMatch[0].toUpperCase();
        if (!index.has(pCode)) {
          index.set(pCode, fullPath);
        } else {
          logger.warn(`[PlanoUploader] P-code duplicado "${pCode}": "${fullPath}" (ya estaba "${index.get(pCode)}"). Se conserva el primero (orden DFS).`);
        }
      } else if (shouldScanDirectory(entry.name)) {
        await walk(fullPath, depth + 1);
      }
    }
  }

  await walk(root, 0);
  return index;
}

let indexCache = { map: null, root: null, builtAt: 0 };

/**
 * Devuelve el índice cacheado de carpetas de proyecto para `root`.
 * Reutiliza el cache mientras no haya expirado (PLANO_INDEX_TTL_MS) y el root coincida.
 *
 * @param {string} root Directorio base (ej: 1ACTIVOS)
 * @returns {Promise<Map<string, string>>} Mapa P-code → ruta absoluta
 */
async function getProjectFolderIndex(root) {
  const now = Date.now();
  if (indexCache.map && indexCache.root === root && (now - indexCache.builtAt) < config.PLANO_INDEX_TTL_MS) {
    return indexCache.map;
  }
  logger.info(`[PlanoUploader] Construyendo índice de carpetas para "${root}"...`);
  const map = await buildProjectFolderIndex(root);
  indexCache = { map, root, builtAt: now };
  logger.info(`[PlanoUploader] Índice construido: ${map.size} carpetas de proyecto en cache.`);
  return map;
}

function invalidateProjectFolderIndex() {
  indexCache = { map: null, root: null, builtAt: 0 };
}

module.exports = {
  processJobPlano,
  resolveFabricacionFolder,
  listMatchingPdfs,
  listTopLevelPdfs,
  selectPlanoPdfs,
  parsePlansUrl,
  normalizeAscii,
  validatePdfBuffer,
  uploadPlanoToStorage,
  updatePlansUrl,
  buildProjectFolderIndex,
  getProjectFolderIndex,
  invalidateProjectFolderIndex
};
