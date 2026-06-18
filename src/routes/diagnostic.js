const express = require('express');
const asyncHandler = require('../utils/async-handler');
const fs = require('fs');
const os = require('os');
const { jobQueue } = require('../jobs/bull-queue');
const { checkDiskSpace } = require('../utils/disk');
const { logger } = require('../utils/logger');
const config = require('../config');
const pkg = require('../../package.json');
const { verifyApiToken } = require('../middleware/api-auth');
const { connection } = require('../utils/redis-connection');
const { supabase } = require('../services/supabase');

const router = express.Router();

function withTimeout(promise, ms) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout tras ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

router.get('/health', asyncHandler(async (req, res) => {
  let smbMounted = false;
  let diskSpace = null;
  let redisOk = false;
  let supabaseOk = false;

  const storageCheck = (async () => {
    await fs.promises.access(config.TRABAJOS_BASE_PATH);
    const space = await checkDiskSpace(config.TRABAJOS_BASE_PATH, 3000);
    return space;
  })();

  const storageTimeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Timeout verificando almacenamiento')), 5000)
  );

  try {
    const space = await Promise.race([storageCheck, storageTimeout]);
    smbMounted = true;
    diskSpace = {
      freeMB: space.freeMB.toFixed(2),
      isSafe: space.isSafe,
      minRequiredMB: config.MIN_DISK_MB
    };
  } catch (err) {
    logger.error('Healthcheck: Error verificando almacenamiento:', err.message);
  }

  try {
    await withTimeout(connection.ping(), config.HEALTH_PING_TIMEOUT_MS);
    redisOk = true;
  } catch (err) {
    logger.error('Healthcheck: Error verificando Redis:', err.message);
  }

  try {
    const { error } = await withTimeout(
      supabase.from('jobs').select('id', { count: 'exact', head: true }),
      config.HEALTH_PING_TIMEOUT_MS
    );
    supabaseOk = !error;
  } catch (err) {
    logger.error('Healthcheck: Error verificando Supabase:', err.message);
  }

  const isHealthy = smbMounted && (!diskSpace || diskSpace.isSafe) && redisOk && supabaseOk;
  const status = isHealthy ? 'ok' : 'unhealthy';
  const statusCode = isHealthy ? 200 : 500;

  res.status(statusCode).json({
    status,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    smb_mounted: smbMounted,
    disk: diskSpace,
    redis: redisOk,
    supabase: supabaseOk,
    version: pkg.version
  });
}));

router.get('/status', verifyApiToken, asyncHandler(async (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    timestamp: new Date().toISOString(),
    queue: await jobQueue.getStatus(),
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal
    },
    node_version: process.version,
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    dev_mode: config.IS_DEV_MODE
  });
}));

router.get('/metrics', verifyApiToken, asyncHandler(async (req, res) => {
  const status = await jobQueue.getStatus();
  const mem = process.memoryUsage();

  let freeMB = 0;
  try {
    const space = await checkDiskSpace();
    freeMB = space.freeMB;
  } catch (err) {
    logger.error('Prometheus metrics: Error checking disk space:', err);
  }

  const prometheusText = [
    '# HELP photo_sync_jobs_total Total number of jobs processed',
    '# TYPE photo_sync_jobs_total counter',
    `photo_sync_jobs_total{status="success"} ${status.totalProcessed}`,
    `photo_sync_jobs_total{status="failed"} ${status.totalErrors}`,
    '',
    '# HELP photo_sync_session_jobs_total Total number of jobs processed in the current session',
    '# TYPE photo_sync_session_jobs_total counter',
    `photo_sync_session_jobs_total{status="success"} ${status.sessionProcessed}`,
    '',
    '# HELP photo_sync_photos_total Total number of photos downloaded',
    '# TYPE photo_sync_photos_total counter',
    `photo_sync_photos_total ${status.totalPhotos}`,
    '',
    '# HELP photo_sync_session_photos_total Total number of photos downloaded in the current session',
    '# TYPE photo_sync_session_photos_total counter',
    `photo_sync_session_photos_total ${status.sessionPhotos}`,
    '',
    '# HELP photo_sync_queue_pending Current jobs waiting in queue',
    '# TYPE photo_sync_queue_pending gauge',
    `photo_sync_queue_pending ${status.pendingCount}`,
    '',
    '# HELP photo_sync_disk_free_mb Free disk space in MB',
    '# TYPE photo_sync_disk_free_mb gauge',
    `photo_sync_disk_free_mb ${freeMB.toFixed(2)}`,
    '',
    '# HELP photo_sync_process_uptime_seconds Process uptime in seconds',
    '# TYPE photo_sync_process_uptime_seconds gauge',
    `photo_sync_process_uptime_seconds ${Math.floor(process.uptime())}`,
    '',
    '# HELP photo_sync_memory_bytes Memory usage in bytes',
    '# TYPE photo_sync_memory_bytes gauge',
    `photo_sync_memory_bytes{type="rss"} ${mem.rss}`,
    `photo_sync_memory_bytes{type="heapTotal"} ${mem.heapTotal}`,
    `photo_sync_memory_bytes{type="heapUsed"} ${mem.heapUsed}`
  ].join('\n') + '\n';

  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(prometheusText);
}));

module.exports = router;