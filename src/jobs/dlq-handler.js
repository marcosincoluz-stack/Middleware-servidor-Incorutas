const { logger } = require('../utils/logger');

/**
 * Obtiene la lista de trabajos fallidos (Dead-Letter Queue).
 * Mapea la estructura de BullMQ a un formato简化 para la API.
 *
 * @param {import('bullmq').Queue} queue Instancia de BullMQ Queue
 * @returns {Promise<Array<{bullJobId: string, jobId: string, title: string, event: string, failedAt: string, error: string, attemptsMade: number}>>}
 */
async function getFailedJobs(queue) {
  const failed = await queue.getFailed();
  return failed.map(job => ({
    bullJobId: job.id,
    jobId: job.data.jobId,
    title: job.data.title,
    event: job.data.event,
    failedAt: new Date(job.failedReason ? job.finishedOn : job.processedOn).toISOString(),
    error: job.failedReason,
    attemptsMade: job.attemptsMade
  }));
}

/**
 * Reintenta un trabajo fallido: lo elimina de la DLQ y lo vuelve a encolar.
 *
 * @param {import('bullmq').Queue} queue Instancia de BullMQ Queue
 * @param {string} bullJobId ID del job en BullMQ (ej: 'job.approved-123')
 * @param {Function} enqueueFn Función para re-encolar (jobId, title, event)
 * @returns {Promise<void>}
 * @throws {Error} Si el job no existe en la cola de fallidos
 */
async function retryFailedJob(queue, bullJobId, enqueueFn) {
  const job = await queue.getJob(bullJobId);
  if (!job) {
    throw new Error(`No se encontró el trabajo con ID "${bullJobId}" en la lista de fallidos`);
  }

  const { jobId, title, event } = job.data;
  logger.info(`Reintentando job fallido de DLQ: ${jobId} (Bull ID: ${bullJobId})`);

  await job.remove();
  await enqueueFn(jobId, title, event);
}

/**
 * Limpia todos los trabajos fallidos de Redis.
 *
 * @param {import('bullmq').Queue} queue Instancia de BullMQ Queue
 * @returns {Promise<void>}
 */
async function clearFailedJobs(queue) {
  await queue.clean(0, 0, 'failed');
  logger.info('Se han limpiado todos los trabajos fallidos de Redis.');
}

module.exports = { getFailedJobs, retryFailedJob, clearFailedJobs };