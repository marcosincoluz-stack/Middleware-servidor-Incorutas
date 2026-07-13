// @ts-check
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { logger } = require('../utils/logger');
const { supabase } = require('../services/supabase');
const { jobQueue } = require('./bull-queue');
const notify = require('../utils/notify');
const { getProjectFolderIndex, invalidateProjectFolderIndex, listMatchingPdfs, parsePlansUrl } = require('../services/plano-uploader');

/**
 * Determina si la hora actual cae dentro del horario laboral configurado.
 * @param {Date} [now] - Fecha/hora a evaluar (inyectable para tests)
 * @returns {boolean}
 */
function isBusinessHours(now = new Date()) {
  const day = now.getDay();       // 0=Dom, 1=Lun, ..., 6=Sáb
  const hour = now.getHours();    // 0-23 (hora local del servidor)

  if (!config.BUSINESS_DAYS.includes(day)) return false;
  return hour >= config.BUSINESS_HOURS_START && hour < config.BUSINESS_HOURS_END;
}

/**
 * Calcula el intervalo del próximo ciclo rápido de polling.
 *
 * - Si el adaptativo está desactivado → devuelve el intervalo base.
 * - Si estamos en horario laboral → devuelve el intervalo base (siempre rápido).
 * - Fuera de horario, tras N ciclos vacíos → backoff exponencial con techo.
 *
 * @param {number} idleStreak - Ciclos consecutivos sin encontrar trabajo
 * @param {Date} [now] - Fecha/hora actual (inyectable para tests)
 * @returns {number} Intervalo en milisegundos
 */
function computeAdaptiveInterval(idleStreak, now = new Date()) {
  if (!config.ADAPTIVE_POLLING_ENABLED) return config.POLLING_INTERVAL_MS;
  if (isBusinessHours(now)) return config.POLLING_INTERVAL_MS;
  if (idleStreak < config.ADAPTIVE_IDLE_THRESHOLD) return config.POLLING_INTERVAL_MS;

  const exponent = idleStreak - config.ADAPTIVE_IDLE_THRESHOLD;
  const computed = config.POLLING_INTERVAL_MS * Math.pow(2, exponent);
  return Math.min(computed, config.ADAPTIVE_MAX_INTERVAL_MS);
}

/**
 * @typedef {Object} PollResult
 * @property {number} found - Jobs encontrados en Supabase
 * @property {number} enqueued - Jobs encolados en BullMQ
 * @property {number} skipped - Jobs omitidos (duplicados en cola)
 */

const SUPABASE_QUERY_TIMEOUT_MS = 10000;

function withTimeout(promise, ms = SUPABASE_QUERY_TIMEOUT_MS) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout consultando Supabase tras ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

/**
 * Consulta Supabase por jobs pendientes de descarga (approved o paid sin downloaded_at)
 * y los encola en BullMQ como 'job.approved'.
 *
 * Respeta el backpressure: si hay >= BACKFILL_MAX_PENDING jobs en cola, no encola más.
 *
 * @returns {Promise<{ found: number, enqueued: number, skipped: number }>}
 */
async function pollApprovedJobs() {
  const pendingCount = await jobQueue.getPendingCount();
  if (pendingCount >= config.BACKFILL_MAX_PENDING) {
    logger.debug(`[Polling] Backpressure: ${pendingCount} jobs pendientes (límite ${config.BACKFILL_MAX_PENDING}). Skip ciclo approved.`);
    return { found: 0, enqueued: 0, skipped: 0 };
  }

  const { data: jobs, error } = await withTimeout(
    supabase
      .from('jobs')
      .select('id, title, status, downloaded_at')
      .in('status', ['approved', 'paid'])
      .is('downloaded_at', null)
      .order('created_at', { ascending: true })
      .limit(config.BACKFILL_MAX_JOBS)
  );

  if (error) throw error;

  if (!jobs || jobs.length === 0) {
    return { found: 0, enqueued: 0, skipped: 0 };
  }

  let enqueued = 0;
  let skipped = 0;

  for (const job of jobs) {
    try {
      await jobQueue.enqueue(job.id, job.title, 'job.approved');
      enqueued++;
    } catch (err) {
      logger.debug(`[Polling] Job ${job.id} no encolado (probablemente duplicado): ${err.message}`);
      skipped++;
    }
  }

  logger.info(`[Polling] Jobs approved: ${jobs.length} encontrados, ${enqueued} encolados, ${skipped} duplicados`);
  return { found: jobs.length, enqueued, skipped };
}

/**
 * Consulta Supabase por jobs pagados y descargados que aún tienen carpeta en 1ACTIVOS.
 * Los encola en BullMQ como 'job.paid' para mover a TERMINADOS.
 *
 * Hace un solo readdir de 1ACTIVOS por ciclo para verificar qué carpetas siguen activas.
 *
 * @returns {Promise<{ found: number, enqueued: number, skipped: number }>}
 */
async function pollPaidJobs() {
  if (!config.ENABLE_FOLDER_MOVE) {
    return { found: 0, enqueued: 0, skipped: 0 };
  }

  const activosPath = path.join(config.TRABAJOS_BASE_PATH, '1ACTIVOS');

  let activosEntries = [];
  try {
    activosEntries = await fs.promises.readdir(activosPath, { withFileTypes: true });
  } catch (err) {
    logger.debug(`[Polling] No se pudo leer 1ACTIVOS: ${err.message}`);
    return { found: 0, enqueued: 0, skipped: 0 };
  }

  const activosFolders = activosEntries
    .filter(d => d.isDirectory())
    .map(d => d.name.toUpperCase());

  if (activosFolders.length === 0) {
    return { found: 0, enqueued: 0, skipped: 0 };
  }

  const { data: jobs, error } = await withTimeout(
    supabase
      .from('jobs')
      .select('id, title, downloaded_at')
      .eq('status', 'paid')
      .not('downloaded_at', 'is', null)
      .order('downloaded_at', { ascending: false })
      .limit(config.BACKFILL_MAX_JOBS)
  );

  if (error) throw error;

  if (!jobs || jobs.length === 0) {
    return { found: 0, enqueued: 0, skipped: 0 };
  }

  let enqueued = 0;
  let skipped = 0;

  for (const job of jobs) {
    const match = (job.title || '').trim().match(/^(P\d+)/i);
    if (!match) {
      skipped++;
      continue;
    }

    const projectCode = match[1].toUpperCase();
    const stillActive = activosFolders.some(folder => folder.startsWith(projectCode));

    if (!stillActive) {
      skipped++;
      continue;
    }

    try {
      await jobQueue.enqueue(job.id, job.title, 'job.paid');
      enqueued++;
    } catch (err) {
      logger.debug(`[Polling] Job paid ${job.id} no encolado (probablemente duplicado): ${err.message}`);
      skipped++;
    }
  }

  logger.info(`[Polling] Jobs paid: ${jobs.length} encontrados, ${enqueued} encolados para move, ${skipped} ya movidos/duplicados`);
  return { found: jobs.length, enqueued, skipped };
}

/**
 * Auto-healing: busca jobs approved/paid ya descargados que tengan evidence
 * con local_path IS NULL, y re-intenta descargar las evidencias faltantes.
 *
 * Consulta primero la tabla jobs filtrando por status, luego evidence de esos jobs,
 * para evitar que evidence huérfana de jobs rejected/cancelled llene el LIMIT.
 *
 * @returns {Promise<{ found: number, healed: number }>}
 */
async function pollStaleJobs() {
  logger.debug('[Polling] Auto-heal: iniciando ciclo');

  const { data: candidateJobs, error: jobsError } = await withTimeout(
    supabase
      .from('jobs')
      .select('id, title, downloaded_at')
      .in('status', ['approved', 'paid'])
      .not('downloaded_at', 'is', null)
      .order('downloaded_at', { ascending: false })
      .limit(100)
  );

  if (jobsError) throw jobsError;
  if (!candidateJobs || candidateJobs.length === 0) {
    logger.debug('[Polling] Auto-heal: no hay jobs descargados approved/paid');
    return { found: 0, healed: 0 };
  }

  const jobIds = candidateJobs.map(j => j.id);

  const { data: pendingEvidence, error: evError } = await supabase
    .from('evidence')
    .select('job_id')
    .in('job_id', jobIds)
    .in('type', ['photo', 'signature'])
    .is('local_path', null);

  if (evError) throw evError;
  if (!pendingEvidence || pendingEvidence.length === 0) {
    return { found: 0, healed: 0 };
  }

  const pendingJobIds = new Set(pendingEvidence.map(e => e.job_id));
  const staleJobs = candidateJobs.filter(j => pendingJobIds.has(j.id));

  if (staleJobs.length === 0) {
    return { found: 0, healed: 0 };
  }

  logger.info(`[Polling] Auto-heal: ${staleJobs.length} jobs con evidencias pendientes`);

  let healed = 0;

  for (const job of staleJobs) {
    try {
      const { retryFailedEvidences } = require('../services/downloader');
      logger.info(`[Polling] Auto-heal: Job ${job.id} ("${job.title}") tiene evidencias pendientes. Reintentando...`);
      const result = await retryFailedEvidences(job.id);
      if (result.succeeded > 0) {
        healed++;
        const { metricsTracker } = require('./metrics-tracker');
        metricsTracker.addPhotos(result.succeeded);
      }
    } catch (err) {
      logger.error(`[Polling] Auto-heal falló para Job ${job.id}: ${err.message}`);
    }
  }

  logger.info(`[Polling] Auto-heal: ${staleJobs.length} jobs con evidencias pendientes, ${healed} curados`);

  return { found: staleJobs.length, healed };
}

/**
 * Consulta Supabase por jobs pending y, para cada uno, verifica si hay planos NUEVOS
 * en FABRICACION (PDFs que empiezan por el P-code y cuyo name no está ya en plans_url).
 * Si hay planos nuevos, los encola en BullMQ como 'job.plano' (auto-append).
 *
 * Usa un índice cacheado P-code → ruta de 1ACTIVOS (rebuild on miss) para minimizar
 * readdir en SMB. Omite jobs que ya tienen PLANO_MAX_PLANOS_PER_JOB planos subidos.
 * Respeta el backpressure.
 *
 * @returns {Promise<{ found: number, enqueued: number, skipped: number }>}
 */
async function pollPlanosJobs() {
  if (!config.ENABLE_PLANO_UPLOAD) {
    return { found: 0, enqueued: 0, skipped: 0 };
  }

  if (!Array.isArray(config.PLANO_UPLOAD_STATUSES) || config.PLANO_UPLOAD_STATUSES.length === 0) {
    logger.debug('[Polling] PLANO_UPLOAD_STATUSES vacío. Skip ciclo planos.');
    return { found: 0, enqueued: 0, skipped: 0 };
  }

  const pendingCount = await jobQueue.getPendingCount();
  if (pendingCount >= config.BACKFILL_MAX_PENDING) {
    logger.debug(`[Polling] Backpressure: ${pendingCount} jobs pendientes (límite ${config.BACKFILL_MAX_PENDING}). Skip ciclo planos.`);
    return { found: 0, enqueued: 0, skipped: 0 };
  }

  const { data: noPlanoJobs, error: err1 } = await withTimeout(
    supabase
      .from('jobs')
      .select('id, title, plans_url')
      .in('status', config.PLANO_UPLOAD_STATUSES)
      .is('plans_url', null)
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
      .limit(config.BACKFILL_MAX_JOBS)
  );

  if (err1) throw err1;

  let jobs = noPlanoJobs || [];

  if (jobs.length < config.BACKFILL_MAX_JOBS) {
    const slots = config.BACKFILL_MAX_JOBS - jobs.length;
    const { data: hasPlanoJobs, error: err2 } = await withTimeout(
      supabase
        .from('jobs')
        .select('id, title, plans_url')
        .in('status', config.PLANO_UPLOAD_STATUSES)
        .not('plans_url', 'is', null)
        .is('deleted_at', null)
        .order('created_at', { ascending: true })
        .limit(slots)
    );
    if (err2) throw err2;
    jobs = jobs.concat(hasPlanoJobs || []);
  }

  if (jobs.length === 0) {
    return { found: 0, enqueued: 0, skipped: 0 };
  }

  const activosPath = path.join(config.TRABAJOS_BASE_PATH, '1ACTIVOS');

  let index;
  try {
    index = await getProjectFolderIndex(activosPath);
  } catch (err) {
    logger.debug(`[Polling] No se pudo construir índice de 1ACTIVOS para planos: ${err.message}`);
    return { found: jobs.length, enqueued: 0, skipped: jobs.length };
  }

  let enqueued = 0;
  let skipped = 0;
  let indexRebuilt = false;

  for (const job of jobs) {
    const match = (job.title || '').trim().match(/^(P\d+)/i);
    if (!match) {
      skipped++;
      continue;
    }

    const projectCode = match[1].toUpperCase();

    const existingPlans = parsePlansUrl(job.plans_url);
    const uploadedNames = new Set(existingPlans.filter(e => e.name).map(e => e.name));

    if (existingPlans.length >= config.PLANO_MAX_PLANOS_PER_JOB) {
      skipped++;
      continue;
    }

    let folderPath = index.get(projectCode);

    if (!folderPath && !indexRebuilt) {
      logger.debug(`[Polling] P-code "${projectCode}" no en índice. Reconstruyendo (carpeta posiblemente nueva)...`);
      invalidateProjectFolderIndex();
      index = await getProjectFolderIndex(activosPath);
      indexRebuilt = true;
      folderPath = index.get(projectCode);
    }

    if (!folderPath) {
      skipped++;
      continue;
    }

    const fabricacionPath = path.join(folderPath, config.PLANO_SCAN_SUBFOLDER);
    let pdfs;
    try {
      pdfs = await listMatchingPdfs(fabricacionPath, projectCode);
    } catch (err) {
      logger.debug(`[Polling] readdir FABRICACION falló para ${projectCode}: ${err.message}`);
      skipped++;
      continue;
    }

    const hasNew = pdfs.some(p => !uploadedNames.has(p.name));
    if (!hasNew) {
      skipped++;
      continue;
    }

    try {
      await jobQueue.enqueue(job.id, job.title, 'job.plano');
      enqueued++;
    } catch (err) {
      logger.debug(`[Polling] Job plano ${job.id} no encolado (probablemente duplicado): ${err.message}`);
      skipped++;
    }
  }

  logger.info(`[Polling] Planos: ${jobs.length} encontrados, ${enqueued} con planos nuevos encolados, ${skipped} sin novedad/duplicados`);
  return { found: jobs.length, enqueued, skipped };
}

let fastInterval = null;
let slowInterval = null;
let fastIdleStreak = 0;
let currentFastInterval = 0;
let approvedFailCount = 0;
let paidFailCount = 0;
let planoFailCount = 0;
let planoStalledCount = 0;
let lastApprovedAlert = 0;
let lastPaidAlert = 0;
let lastPlanoAlert = 0;
let isFastPolling = false;
let isSlowPolling = false;

async function runFastCycle() {
  try {
    const result = await pollApprovedJobs();
    approvedFailCount = 0;

    // Tracking adaptativo
    if (result.found > 0) {
      fastIdleStreak = 0;
    } else {
      fastIdleStreak++;
    }
  } catch (err) {
    logger.error(`[Polling] Error en ciclo approved: ${err.message}`);
    approvedFailCount++;
    await maybeAlertPollingFailure(approvedFailCount, err.message, 'approved', lastApprovedAlert, (ts) => { lastApprovedAlert = ts; });
  }
}

async function runSlowCycle() {
  try {
    await pollPaidJobs();
    paidFailCount = 0;
  } catch (err) {
    logger.error(`[Polling] Error en ciclo paid: ${err.message}`);
    paidFailCount++;
    await maybeAlertPollingFailure(paidFailCount, err.message, 'paid', lastPaidAlert, (ts) => { lastPaidAlert = ts; });
  }

  try {
    await pollStaleJobs();
  } catch (err) {
    logger.error(`[Polling] Error en ciclo auto-heal: ${err.message}`);
  }

  try {
    const planoResult = await pollPlanosJobs();
    planoFailCount = 0;
    if (planoResult.found > 0 && planoResult.enqueued === 0) {
      planoStalledCount++;
      const { metricsTracker } = require('./metrics-tracker');
      metricsTracker.planoStalledCycles = planoStalledCount;
    } else {
      planoStalledCount = 0;
      const { metricsTracker } = require('./metrics-tracker');
      metricsTracker.planoStalledCycles = 0;
    }
  } catch (err) {
    logger.error(`[Polling] Error en ciclo planos: ${err.message}`);
    planoFailCount++;
    await maybeAlertPollingFailure(planoFailCount, err.message, 'planos', lastPlanoAlert, (ts) => { lastPlanoAlert = ts; });
  }
}

async function maybeAlertPollingFailure(failCount, lastError, cycleType, lastAlertSent, setAlertSent) {
  if (failCount < config.POLLING_FAILURE_ALERT_THRESHOLD) return;

  const now = Date.now();
  if (now - lastAlertSent < config.POLLING_ALERT_COOLDOWN_MS) return;

  setAlertSent(now);
  try {
    await notify.alertPollingFailure(failCount, lastError, cycleType);
  } catch (err) {
    logger.error(`[Polling] Error enviando alerta Telegram: ${err.message}`);
  }
}

/**
 * Inicia el polling híbrido de jobs.
 * Timer rápido (POLLING_INTERVAL_MS): detecta jobs approved para descarga de imágenes.
 * Timer lento (SLOW_POLLING_INTERVAL_MS): paid (move), stale (auto-heal), planos.
 * Ejecuta ambos ciclos inmediatamente al arrancar y luego repite cada uno en su intervalo.
 */
function startPolling() {
  const adaptiveLabel = config.ADAPTIVE_POLLING_ENABLED
    ? `Adaptativo: ON (threshold=${config.ADAPTIVE_IDLE_THRESHOLD}, techo=${config.ADAPTIVE_MAX_INTERVAL_MS}ms, horario=${config.BUSINESS_HOURS_START}:00-${config.BUSINESS_HOURS_END}:00)`
    : 'Adaptativo: OFF';
  logger.info(`[Polling] Iniciado. Rápido: ${config.POLLING_INTERVAL_MS}ms | Lento: ${config.SLOW_POLLING_INTERVAL_MS}ms | ${adaptiveLabel}`);

  const runGuardedFast = () => {
    if (isFastPolling) {
      logger.debug('[Polling] Ciclo rápido anterior aún en curso. Skip.');
      scheduleFastCycle();
      return;
    }
    isFastPolling = true;
    runFastCycle()
      .finally(() => {
        isFastPolling = false;
        scheduleFastCycle();
      });
  };

  const scheduleFastCycle = () => {
    const interval = computeAdaptiveInterval(fastIdleStreak);

    if (interval !== currentFastInterval) {
      if (currentFastInterval > 0) {
        logger.info(`[Polling] Intervalo adaptado: ${currentFastInterval}ms → ${interval}ms (idle streak: ${fastIdleStreak})`);
      }
      currentFastInterval = interval;
    }

    fastInterval = setTimeout(runGuardedFast, interval);

    if (fastInterval && typeof fastInterval.unref === 'function') {
      fastInterval.unref();
    }
  };

  const runGuardedSlow = () => {
    if (isSlowPolling) {
      logger.debug('[Polling] Ciclo lento anterior aún en curso. Skip.');
      return;
    }
    isSlowPolling = true;
    runSlowCycle().finally(() => { isSlowPolling = false; });
  };

  // Ejecución inicial de ambos ciclos
  currentFastInterval = config.POLLING_INTERVAL_MS;
  runGuardedFast();
  runGuardedSlow();

  slowInterval = setInterval(runGuardedSlow, config.SLOW_POLLING_INTERVAL_MS);

  if (slowInterval && typeof slowInterval.unref === 'function') {
    slowInterval.unref();
  }
}

/**
 * Detiene ambos timers de polling.
 */
function stopPolling() {
  if (fastInterval) {
    clearTimeout(fastInterval);
    fastInterval = null;
  }
  if (slowInterval) {
    clearInterval(slowInterval);
    slowInterval = null;
  }
  fastIdleStreak = 0;
  currentFastInterval = 0;
  logger.info('[Polling] Detenido.');
}

function getCurrentFastInterval() {
  return currentFastInterval;
}

module.exports = {
  startPolling,
  stopPolling,
  pollApprovedJobs,
  pollPaidJobs,
  pollStaleJobs,
  pollPlanosJobs,
  runFastCycle,
  runSlowCycle,
  // Funciones expuestas para tests y métricas
  isBusinessHours,
  computeAdaptiveInterval,
  getCurrentFastInterval,
};
