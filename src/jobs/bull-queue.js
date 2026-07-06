const { Queue, Worker } = require('bullmq');
const config = require('../config');
const { logger } = require('../utils/logger');
const { processJobApproved, cleanupOrphanedPartFiles } = require('../services/downloader');
const { moveJobToTerminados } = require('../services/folder-mover');
const { processJobPlano } = require('../services/plano-uploader');
const { metricsTracker } = require('./metrics-tracker');
const { getFailedJobs, retryFailedJob, clearFailedJobs } = require('./dlq-handler');
const { connection } = require('../utils/redis-connection');
const { CircuitBreaker } = require('../utils/circuit-breaker');

const JOB_NAME = 'sync-task';

const supabaseBreaker = new CircuitBreaker('supabase', {
  failureThreshold: config.CIRCUIT_BREAKER_THRESHOLD,
  resetTimeoutMs: config.CIRCUIT_BREAKER_RESET_MS,
});

class BullJobQueue {
  constructor() {
    this.queueName = 'photo-sync-queue';

    this.queue = new Queue(this.queueName, { connection });

    this.worker = new Worker(this.queueName, async (job) => {
      const { jobId, title, event } = job.data;
      logger.info(`Cola (Worker): Procesando Job ${jobId} | Evento: ${event} | Intento: ${job.attemptsMade + 1}/${job.opts.attempts}`);

      metricsTracker.currentJob = { jobId, title, event };
      metricsTracker.currentJobStartedAt = new Date().toISOString();
      metricsTracker.activeJobId = job.id;

      if (event === 'job.approved') {
        logger.info(`[Downloader] Iniciando descargas para Job ${jobId} ("${title}")`);
        await supabaseBreaker.execute(() => processJobApproved(jobId, title));
      } else if (event === 'job.paid') {
        if (config.ENABLE_FOLDER_MOVE) {
          logger.info(`[FolderMover] Moviendo carpeta a TERMINADOS para Job ${jobId} ("${title}")`);
          await supabaseBreaker.execute(() => moveJobToTerminados(jobId, title));
        } else {
          logger.info(`[FolderMover] Omitiendo movimiento a TERMINADOS para Job ${jobId} (desactivado)`);
        }
      } else if (event === 'job.plano') {
        if (config.ENABLE_PLANO_UPLOAD) {
          logger.info(`[PlanoUploader] Subiendo plano para Job ${jobId} ("${title}")`);
          await supabaseBreaker.execute(() => processJobPlano(jobId, title));
        } else {
          logger.info(`[PlanoUploader] Subida de planos desactivada (ENABLE_PLANO_UPLOAD=false). Omitiendo Job ${jobId}.`);
        }
      } else {
        throw new Error(`Evento desconocido "${event}" recibido en la cola`);
      }
    }, {
      connection,
      concurrency: config.QUEUE_CONCURRENCY,
      limiter: {
        max: config.LIMITER_MAX,
        duration: config.LIMITER_DURATION_MS,
      },
      stalledInterval: config.STALLED_INTERVAL_MS,
      lockDuration: config.LOCK_DURATION_MS,
    });

    this.worker.on('completed', (job) => metricsTracker.onCompleted(job));
    this.worker.on('failed', (job, err) => metricsTracker.onFailed(job, err));
    this.worker.on('error', (err) => {
      logger.error('❌ Error en el Worker de BullMQ:', err);
    });

    this.worker.on('stalled', (jobId) => {
      logger.warn(`⚠️  Job ${jobId} detectado como stalled. Será reintentado automáticamente.`);
    });

    if (config.PART_CLEANUP_ON_STARTUP) {
      cleanupOrphanedPartFiles().catch(err => {
        logger.warn(`Cleanup de .part huérfanos falló: ${err.message}`);
      });
    }
  }

  /**
   * Añade una tarea a la cola BullMQ persistente.
   * Si el job ya existe y está completado o pendiente, se ignora (idempotencia).
   *
   * @param {string} jobId ID del trabajo a procesar
   * @param {string} title Título identificativo del trabajo
   * @param {string} event Tipo de evento ('job.approved' | 'job.paid' | 'job.plano')
   * @returns {Promise<void>}
   */
  async enqueue(jobId, title, event) {
    logger.info(`Cola: Encolando Job ${jobId} ("${title}") | Evento: ${event}`);

    const bullJobId = `${event}-${jobId}`;

    const existingJob = await this.queue.getJob(bullJobId);
    if (existingJob) {
      const state = await existingJob.getState();
      if (state === 'completed') {
        if (event === 'job.plano') {
          logger.debug(`Cola: Job ${bullJobId} completado. Re-encolando (auto-append de planos puede tener novedad).`);
          try {
            await existingJob.remove();
          } catch (err) {
            logger.debug(`Cola: No se pudo eliminar job completado ${bullJobId}: ${err.message}`);
          }
        } else {
          logger.info(`Cola: Job ${bullJobId} ya fue completado previamente. Ignorando duplicado.`);
          return;
        }
      } else {
        logger.info(`Cola: Job ${bullJobId} ya existe en estado "${state}". Ignorando duplicado.`);
        return;
      }
    }

    await this.queue.add(
      JOB_NAME,
      { jobId, title, event },
      {
        jobId: bullJobId,
        attempts: config.JOB_MAX_RETRIES,
        backoff: {
          type: 'exponential',
          delay: config.JOB_BACKOFF_BASE_MS,
        },
        removeOnComplete: { maxCount: config.REMOVE_ON_MAX },
        removeOnFail: { maxCount: config.REMOVE_ON_MAX },
      }
    );
  }

  /**
   * Incrementa el contador de fotos descargadas (llamado por el downloader).
   *
   * @param {number} count Número de fotos descargadas
   */
  addPhotosCount(count) {
    metricsTracker.addPhotos(count);
  }

  addRejectedExtensionCount(count) {
    metricsTracker.addRejectedByExtension(count);
  }

  /**
   * Cierra las conexiones de forma limpia (graceful shutdown).
   *
   * @returns {Promise<void>}
   */
  async shutdown() {
    logger.info('Cerrando conexiones de la cola BullMQ y Redis...');
    await this.worker.close();
    await this.queue.close();
    await connection.quit();
    logger.info('Cola BullMQ apagada limpiamente.');
  }

  /**
   * Retorna el número de elementos pendientes en la cola.
   *
   * @returns {Promise<number>}
   */
  async getPendingCount() {
    const counts = await this.queue.getJobCounts('wait', 'delayed', 'paused');
    return counts.wait + counts.delayed + counts.paused;
  }

  /**
   * Retorna el listado de trabajos fallidos (Dead-Letter Queue).
   *
   * @returns {Promise<Array<{bullJobId: string, jobId: string, title: string, event: string, failedAt: string, error: string, attemptsMade: number}>>}
   */
  async getFailedJobs() {
    return getFailedJobs(this.queue);
  }

  /**
   * Elimina y vuelve a encolar un job fallido.
   *
   * @param {string} bullJobId ID del job en BullMQ
   * @returns {Promise<void>}
   */
  async retryFailedJob(bullJobId) {
    return retryFailedJob(this.queue, bullJobId, this.enqueue.bind(this));
  }

  /**
   * Limpia todos los trabajos fallidos de Redis.
   *
   * @returns {Promise<void>}
   */
  async clearFailedJobs() {
    return clearFailedJobs(this.queue);
  }

  /**
   * Retorna el estado actual de la cola y métricas para el dashboard.
   *
   * @returns {Promise<object>}
   */
  async getStatus() {
    return metricsTracker.getStatus(this.queue);
  }
}

const jobQueue = new BullJobQueue();
module.exports = { jobQueue };