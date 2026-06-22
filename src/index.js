const express = require('express');
const helmet = require('helmet');
const path = require('path');
const config = require('./config');
const errorHandler = require('./middleware/error-handler');
const requestId = require('./middleware/request-id');
const requestLogger = require('./middleware/request-logger');
const { logger } = require('./utils/logger');
const { printBanner } = require('./banner');
const { handleGracefulShutdown } = require('./shutdown');
const { startPolling } = require('./jobs/polling');
const { checkDiskSpace } = require('./utils/disk');
const notify = require('./utils/notify');

const diagnosticRouter = require('./routes/diagnostic');
const apiRouter = require('./routes/api');
const dlqRouter = require('./routes/dlq');

const app = express();

app.use(helmet({
  contentSecurityPolicy: false
}));
app.set('trust proxy', 1);

app.use(express.static(path.join(__dirname, 'public')));

app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

app.use(requestId);
app.use(requestLogger);

// Rutas con API versioning (/v1/)
app.use('/v1', diagnosticRouter);
app.use('/v1/api', apiRouter);
app.use('/v1/api', dlqRouter);

// Rutas legacy (sin /v1/) para compatibilidad con dashboard
app.use(diagnosticRouter);
app.use('/api', apiRouter);
app.use('/api', dlqRouter);

// Error handler centralizado (debe ir después de todas las rutas)
app.use(errorHandler);

const server = app.listen(config.PORT, () => {
  printBanner(server);
  if (config.POLLING_ENABLED) {
    startPolling();
  }
  startDiskMonitor();
});

let diskMonitorInterval = null;
let lastDiskAlert = 0;
const DISK_MONITOR_INTERVAL_MS = 300000;
const DISK_ALERT_COOLDOWN_MS = 600000;

function startDiskMonitor() {
  const checkDisk = async () => {
    try {
      const disk = await checkDiskSpace();
      const now = Date.now();
      const warningThreshold = config.MIN_DISK_MB * 2;

      if (!disk.isSafe) {
        if (now - lastDiskAlert > DISK_ALERT_COOLDOWN_MS) {
          lastDiskAlert = now;
          await notify.alertLowDisk(disk.freeMB, config.MIN_DISK_MB);
        }
      } else if (disk.freeMB < warningThreshold) {
        if (now - lastDiskAlert > DISK_ALERT_COOLDOWN_MS) {
          lastDiskAlert = now;
          await notify.alertDiskWarning(disk.freeMB, config.MIN_DISK_MB);
        }
      } else {
        lastDiskAlert = 0;
      }
    } catch (err) {
      logger.debug(`Disk monitor: error comprobando disco: ${err.message}`);
    }
  };

  diskMonitorInterval = setInterval(checkDisk, DISK_MONITOR_INTERVAL_MS);
  if (diskMonitorInterval && typeof diskMonitorInterval.unref === 'function') {
    diskMonitorInterval.unref();
  }
}

function stopDiskMonitor() {
  if (diskMonitorInterval) {
    clearInterval(diskMonitorInterval);
    diskMonitorInterval = null;
  }
}

process.on('SIGTERM', () => handleGracefulShutdown('SIGTERM', server));
process.on('SIGINT', () => handleGracefulShutdown('SIGINT', server));

process.on('unhandledRejection', (reason, _promise) => {
  logger.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
  process.exit(1);
});

module.exports = { app, server, stopDiskMonitor };