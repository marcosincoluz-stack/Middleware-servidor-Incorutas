const fs = require('fs');
const path = require('path');
const config = require('../config');
const { logger } = require('../utils/logger');
const { supabase } = require('../services/supabase');
const { jobQueue } = require('./bull-queue');
const notify = require('../utils/notify');

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

let pollInterval = null;
let approvedFailCount = 0;
let paidFailCount = 0;
let lastApprovedAlert = 0;
let lastPaidAlert = 0;
let isPolling = false;

async function runPollCycle() {
  try {
    await pollApprovedJobs();
    approvedFailCount = 0;
  } catch (err) {
    logger.error(`[Polling] Error en ciclo approved: ${err.message}`);
    approvedFailCount++;
    await maybeAlertPollingFailure(approvedFailCount, err.message, 'approved', lastApprovedAlert, (ts) => { lastApprovedAlert = ts; });
  }

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
 * Inicia el polling periódico de jobs.
 * Ejecuta un ciclo inmediato y luego repite cada POLLING_INTERVAL_MS.
 */
function startPolling() {
  logger.info(`[Polling] Iniciado. Intervalo: ${config.POLLING_INTERVAL_MS}ms`);

  const runGuarded = () => {
    if (isPolling) {
      logger.debug('[Polling] Ciclo anterior aún en curso. Skip.');
      return;
    }
    isPolling = true;
    runPollCycle().finally(() => { isPolling = false; });
  };

  runGuarded();

  pollInterval = setInterval(() => {
    runGuarded();
  }, config.POLLING_INTERVAL_MS);

  if (pollInterval && typeof pollInterval.unref === 'function') {
    pollInterval.unref();
  }
}

/**
 * Detiene el polling periódico.
 */
function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    logger.info('[Polling] Detenido.');
  }
}

module.exports = { startPolling, stopPolling, pollApprovedJobs, pollPaidJobs, pollStaleJobs, runPollCycle };
