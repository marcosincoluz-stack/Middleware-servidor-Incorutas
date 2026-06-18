const { logger } = require('./utils/logger');
const { jobQueue } = require('./jobs/bull-queue');
const { metricsStore } = require('./utils/metrics-store');
const { stopPolling } = require('./jobs/polling');

const HTTP_DRAIN_GRACE_MS = 2000;
const FORCE_EXIT_TIMEOUT_MS = 35000;

/**
 * Manejo graceful de señales SIGTERM/SIGINT.
 * Cierra el servidor HTTP, espera a que los jobs activos terminen,
 * cierra conexiones de Redis y persiste métricas.
 */
function handleGracefulShutdown(signal, server) {
  logger.info(`\x1b[33m⏻ Señal ${signal} recibida. Iniciando cierre graceful...\x1b[0m`);

  server.close(() => {
    logger.info('Servidor HTTP cerrado. No se aceptan nuevas peticiones.');
  });

  setTimeout(() => {
    if (typeof server.closeAllConnections === 'function') {
      logger.info('Forzando cierre de conexiones HTTP keep-alive...');
      server.closeAllConnections();
    }
  }, HTTP_DRAIN_GRACE_MS);

  shutdownResources();

  setTimeout(() => {
    logger.error('💀 Forzando apagado por timeout.');
    process.exit(1);
  }, FORCE_EXIT_TIMEOUT_MS);
}

async function shutdownResources() {
  try {
    stopPolling();
  } catch (err) {
    logger.error('Error deteniendo polling:', err.message);
  }

  let checks = 0;
  const maxChecks = 30;
  let queueStatus = await jobQueue.getStatus();

  while (queueStatus.isProcessing && checks < maxChecks) {
    logger.info(`⏳ Esperando fin de tarea activa... (${checks + 1}/${maxChecks}s)`);
    await new Promise(resolve => setTimeout(resolve, 1000));
    queueStatus = await jobQueue.getStatus();
    checks++;
  }

  if (queueStatus.isProcessing) {
    logger.warn('⚠️  Timeout de espera agotado. Cerrando con tareas activas.');
  } else {
    logger.info('✔ Cola finalizada limpiamente.');
  }

  try {
    await jobQueue.shutdown();
  } catch (err) {
    logger.error('Error durante el cierre de la cola BullMQ:', err);
  }

  try {
    metricsStore.shutdown();
  } catch (err) {
    logger.error('Error durante el cierre de MetricsStore:', err);
  }

  logger.info('👋 Proceso finalizado.');
  process.exit(0);
}

module.exports = { handleGracefulShutdown };