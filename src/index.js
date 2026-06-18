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
});

process.on('SIGTERM', () => handleGracefulShutdown('SIGTERM', server));
process.on('SIGINT', () => handleGracefulShutdown('SIGINT', server));

process.on('unhandledRejection', (reason, _promise) => {
  logger.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
  process.exit(1);
});

module.exports = { app, server };