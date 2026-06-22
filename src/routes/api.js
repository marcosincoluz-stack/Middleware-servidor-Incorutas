const express = require('express');
const asyncHandler = require('../utils/async-handler');
const { verifyApiToken } = require('../middleware/api-auth');
const { jobQueue } = require('../jobs/bull-queue');
const { checkDiskSpace } = require('../utils/disk');
const { logger } = require('../utils/logger');
const config = require('../config');
const { supabase } = require('../services/supabase');
const notify = require('../utils/notify');
const { tailFile } = require('../utils/tail-file');
const { retryFailedEvidences } = require('../services/downloader');
const { retryFailedSchema } = require('../validations/retry');
const pkg = require('../../package.json');
const fs = require('fs');
const path = require('path');

const router = express.Router();

router.use(verifyApiToken);

let dashboardCache = { data: null, timestamp: 0 };
let dashboardFetchInProgress = false;
let failedEvidencesCache = { data: null, timestamp: 0 };
let logsCache = { data: null, timestamp: 0 };

router.get('/dashboard', asyncHandler(async (req, res) => {
  const now = Date.now();
  if (dashboardCache.data && (now - dashboardCache.timestamp) < config.DASHBOARD_CACHE_TTL_MS) {
    return res.json(dashboardCache.data);
  }

  if (dashboardFetchInProgress) {
    if (dashboardCache.data) {
      return res.json(dashboardCache.data);
    }
    return res.status(503).json({ error: 'Dashboard refrescando, reintente en unos segundos' });
  }

  dashboardFetchInProgress = true;
  let smbMounted = false;
  let diskInfo = null;
  let supabaseOk = false;

  try {
    const storageCheck = (async () => {
      await fs.promises.access(config.TRABAJOS_BASE_PATH);
      const space = await checkDiskSpace(config.TRABAJOS_BASE_PATH, 3000);
      return space;
    })();
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), 5000)
    );
    const space = await Promise.race([storageCheck, timeoutPromise]);
    smbMounted = true;
    diskInfo = { freeMB: parseFloat(space.freeMB.toFixed(2)), isSafe: space.isSafe };
  } catch (err) {
    logger.error('Dashboard: Error verificando almacenamiento:', err.message);
  }

  try {
    const pingPromise = supabase.from('jobs').select('id', { count: 'exact', head: true });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), 3000)
    );
    const { error } = await Promise.race([pingPromise, timeoutPromise]);
    supabaseOk = !error;
  } catch {
    supabaseOk = false;
  }

  const queue = await jobQueue.getStatus();
  const mem = process.memoryUsage();
  const isHealthy = smbMounted && supabaseOk && (!diskInfo || diskInfo.isSafe);

  const data = {
    status: isHealthy ? 'ok' : 'degraded',
    health: {
      smb: smbMounted,
      supabase: supabaseOk,
      disk: diskInfo,
      minDiskMB: config.MIN_DISK_MB
    },
    queue: {
      isProcessing: queue.isProcessing,
      pendingCount: queue.pendingCount,
      totalProcessed: queue.totalProcessed,
      totalErrors: queue.totalErrors,
      totalPhotos: queue.totalPhotos,
      sessionProcessed: queue.sessionProcessed,
      sessionErrors: queue.sessionErrors,
      sessionPhotos: queue.sessionPhotos,
      currentJob: queue.currentJob,
      currentJobStartedAt: queue.currentJobStartedAt,
      lastJobProcessed: queue.lastJobProcessed,
      lastProcessedAt: queue.lastProcessedAt,
      recentJobs: queue.recentJobs
    },
    process: {
      uptime: process.uptime(),
      memoryMB: parseFloat((mem.rss / 1024 / 1024).toFixed(1)),
      startedAt: queue.startedAt,
      version: pkg.version
    },
    config: {
      devMode: config.IS_DEV_MODE,
      folderMove: config.ENABLE_FOLDER_MOVE,
      telegram: config.HAS_TELEGRAM,
      smbPath: config.TRABAJOS_BASE_PATH
    }
  };

  dashboardCache = { data, timestamp: now };
  dashboardFetchInProgress = false;
  res.json(data);
}));

router.get('/config', asyncHandler(async (req, res) => {
  res.json({
    PORT: config.PORT,
    NODE_ENV: config.NODE_ENV,
    IS_DEV_MODE: config.IS_DEV_MODE,
    TRABAJOS_BASE_PATH: config.TRABAJOS_BASE_PATH,
    MIN_DISK_MB: config.MIN_DISK_MB,
    ENABLE_FOLDER_MOVE: config.ENABLE_FOLDER_MOVE,
    HAS_TELEGRAM: config.HAS_TELEGRAM,
    LOG_LEVEL: config.LOG_LEVEL,
    DOWNLOAD_MAX_RETRIES: config.DOWNLOAD_MAX_RETRIES,
    DOWNLOAD_RETRY_DELAY_MS: config.DOWNLOAD_RETRY_DELAY_MS
  });
}));

router.get('/logs', asyncHandler(async (req, res) => {
  const now = Date.now();
  if (logsCache.data && (now - logsCache.timestamp) < config.SECONDARY_CACHE_TTL_MS) {
    return res.json(logsCache.data);
  }

  const logDir = path.join(__dirname, '../../logs');

  try {
    await fs.promises.access(logDir);
  } catch {
    const data = { logs: ['El directorio de logs no existe.'] };
    logsCache = { data, timestamp: now };
    return res.json(data);
  }

  try {
    const files = (await fs.promises.readdir(logDir))
      .filter(f => f.endsWith('.log') && !f.startsWith('errors-'))
      .sort();

    if (files.length === 0) {
      const data = { logs: ['No se encontraron archivos de logs.'] };
      logsCache = { data, timestamp: now };
      return res.json(data);
    }

    const latestFile = path.join(logDir, files[files.length - 1]);
    const lines = await tailFile(latestFile, { maxLines: 60, maxBytes: config.LOG_TAIL_MAX_BYTES });

    const data = {
      file: files[files.length - 1],
      logs: lines
    };
    logsCache = { data, timestamp: now };
    res.json(data);
  } catch {
    res.status(500).json({ error: 'Error leyendo archivos de logs' });
  }
}));

router.post('/backfill', asyncHandler(async (req, res) => {
  logger.info('👤 Petición de descarga retroactiva (backfill) recibida desde el Dashboard Web.');

  const pendingCount = await jobQueue.getPendingCount();
  if (pendingCount >= config.BACKFILL_MAX_PENDING) {
    logger.warn(`[Backfill] Backpressure: hay ${pendingCount} jobs pendientes (límite: ${config.BACKFILL_MAX_PENDING}). Rechazando backfill.`);
    return res.status(429).json({
      success: false,
      error: `Hay ${pendingCount} trabajos pendientes en la cola. Espera a que se procesen antes de lanzar otro backfill.`
    });
  }

  const { data: jobs, error } = await supabase
    .from('jobs')
    .select('id, title, status, downloaded_at')
    .in('status', ['approved', 'paid'])
    .is('downloaded_at', null)
    .order('created_at', { ascending: true })
    .limit(config.BACKFILL_MAX_JOBS);

  if (error) throw error;

  if (!jobs || jobs.length === 0) {
    return res.json({ success: true, count: 0, message: 'No hay trabajos pendientes de descarga.' });
  }

  if (jobs.length >= config.BACKFILL_MAX_JOBS) {
    logger.warn(`[Backfill] Se alcanzó el límite de ${config.BACKFILL_MAX_JOBS} jobs. Puede haber más trabajos pendientes en la base de datos.`);
  }

  for (const job of jobs) {
    await jobQueue.enqueue(job.id, job.title, 'job.approved');
  }

  res.json({
    success: true,
    count: jobs.length,
    message: `Se han encolado ${jobs.length} trabajos para descarga retroactiva en segundo plano.`
  });
}));

router.post('/test-telegram', asyncHandler(async (req, res) => {
  if (!config.HAS_TELEGRAM) {
    return res.status(400).json({ error: 'Telegram no está configurado en las variables de entorno.' });
  }

  const ok = await notify.send(
    `🔔 <b>[PRUEBA DE CONEXIÓN]</b>\n\n` +
    `Se ha pulsado el botón de prueba desde el Dashboard Web.\n` +
    `<b>Estado del canal:</b> ACTIVO ✅\n` +
    `<b>Timestamp:</b> <code>${new Date().toLocaleString('es-ES')}</code>`
  );

  if (ok) {
    res.json({ success: true, message: 'Mensaje de prueba enviado a Telegram con éxito.' });
  } else {
    res.status(500).json({ error: 'La API de Telegram devolvió un error (revisa los logs).' });
  }
}));

router.get('/failed-evidences', asyncHandler(async (req, res) => {
  const now = Date.now();
  if (failedEvidencesCache.data && (now - failedEvidencesCache.timestamp) < config.SECONDARY_CACHE_TTL_MS) {
    return res.json(failedEvidencesCache.data);
  }

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Timeout consultando Supabase')), 5000)
  );

  const queryPromise = (async () => {
    const { data: jobs, error: jobsError } = await supabase
      .from('jobs')
      .select('id, title, downloaded_at')
      .not('downloaded_at', 'is', null)
      .order('downloaded_at', { ascending: false })
      .limit(config.BACKFILL_MAX_JOBS);

    if (jobsError) throw jobsError;

    if (!jobs || jobs.length === 0) {
      return [];
    }

    const jobIds = jobs.map(j => j.id);

    const { data: failedEvs, error: evError } = await supabase
      .from('evidence')
      .select('job_id')
      .in('job_id', jobIds)
      .eq('type', 'photo')
      .is('local_path', null);

    if (evError) throw evError;

    const failedByJob = new Map();
    for (const ev of (failedEvs || [])) {
      const count = failedByJob.get(ev.job_id) || 0;
      failedByJob.set(ev.job_id, count + 1);
    }

    return jobs
      .filter(job => failedByJob.has(job.id))
      .map(job => ({
        jobId: job.id,
        title: job.title,
        downloadedAt: job.downloaded_at,
        failedCount: failedByJob.get(job.id) || 0
      }));
  })();

  const results = await Promise.race([queryPromise, timeoutPromise]);
  const data = { success: true, jobs: results };
  failedEvidencesCache = { data, timestamp: Date.now() };
  res.json(data);
}));

router.post('/retry-failed/:jobId', asyncHandler(async (req, res) => {
  const parsed = retryFailedSchema.safeParse({ jobId: req.params.jobId });
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues.map(i => i.message).join(', ') });
  }
  const { jobId } = parsed.data;
  logger.info(`👤 Petición de reintento de fotos fallidas para Job ${jobId} desde el Dashboard`);

  const result = await retryFailedEvidences(jobId);
  failedEvidencesCache = { data: null, timestamp: 0 };
  res.json({ success: true, ...result });
}));

module.exports = router;