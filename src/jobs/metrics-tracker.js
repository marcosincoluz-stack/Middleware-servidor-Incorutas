const { metricsStore } = require('../utils/metrics-store');
const { classifyError } = require('./error-classifier');
const notify = require('../utils/notify');
const config = require('../config');
const { logger } = require('../utils/logger');
const { checkDiskSpace } = require('../utils/disk');

class MetricsTracker {
  constructor() {
    this.totalProcessed = 0;
    this.totalErrors = 0;
    this.totalPhotos = 0;
    this.totalRejectedByExtension = 0;
    this.planoStalledCycles = 0;
    this.lastJobProcessed = null;
    this.lastProcessedAt = null;
    this.currentJob = null;
    this.currentJobStartedAt = null;
    this.activeJobId = null;
    this.startedAt = new Date().toISOString();
    this.recentJobs = [];
  }

  addRejectedByExtension(count) {
    metricsStore.addRejectedByExtension(count);
    this.totalRejectedByExtension += count;
  }

  addPlanos(count) {
    metricsStore.addPlanos(count);
  }

  /**
   * Maneja el evento 'completed' del worker.
   * Actualiza métricas de sesión y persistentes.
   *
   * @param {import('bullmq').Job} job Job completado
   */
  onCompleted(job) {
    const { jobId, title } = job.data;
    logger.info(`Cola: Job ${jobId} completado con éxito.`);

    metricsStore.incrementProcessed();
    this.totalProcessed++;
    this.lastJobProcessed = { jobId, title, status: 'success' };
    this.lastProcessedAt = new Date().toISOString();
    this._pushRecentJob({ jobId, title, status: 'success', finishedAt: new Date().toISOString() });
    this._clearActiveJob();
  }

  /**
   * Maneja el evento 'failed' del worker.
   * Clasifica el error y envía alertas apropiadas según el tipo.
   * Solo incrementa errores si se agotaron los reintentos.
   *
   * @param {import('bullmq').Job | null} job Job fallido (null si el error es a nivel de estructura/Redis)
   * @param {Error} err Error que causó el fallo
   */
  async onFailed(job, err) {
    if (!job) {
      logger.error('Cola: Error crítico en el worker (sin job asociado):', err);
      return;
    }

    const { jobId, title } = job.data;
    const attempts = job.opts.attempts;
    const currentAttempt = job.attemptsMade;

    logger.warn(`Cola: Job ${jobId} falló en el intento ${currentAttempt}/${attempts}. Error: ${err.message}`);

    if (currentAttempt >= attempts) {
      logger.error(`Cola: Job ${jobId} falló definitivamente tras ${attempts} intentos.`);
      metricsStore.incrementErrors();
      this.totalErrors++;
      this.lastJobProcessed = { jobId, title, status: 'failed', error: err.message };
      this.lastProcessedAt = new Date().toISOString();
      this._pushRecentJob({ jobId, title, status: 'failed', error: err.message, finishedAt: new Date().toISOString() });

      try {
        const classification = classifyError(err);
        if (classification.type === 'disk_full') {
          const disk = await checkDiskSpace();
          await notify.alertLowDisk(disk.freeMB, config.MIN_DISK_MB);
        } else if (classification.type === 'smb_disconnected') {
          await notify.alertSmbDisconnected(config.TRABAJOS_BASE_PATH);
        } else if (classification.type === 'file_lock') {
          logger.warn(`Cola: Job ${jobId} falló por archivo bloqueado (EBUSY/EPERM). Es transitorio en SMB; BullMQ reintentará.`);
        }
        await notify.alertJobFailed(jobId, title, `Fallo definitivo tras ${attempts} intentos. Error: ${err.message}`);
      } catch (notifyErr) {
        logger.error('Cola: Error enviando notificación de error a Telegram:', notifyErr);
      }
    }

    this._clearActiveJob();
  }

  /**
   * Incrementa el contador de fotos descargadas (llamado por el downloader).
   * Actualiza tanto métricas persistentes como de sesión.
   *
   * @param {number} count Número de fotos descargadas
   */
  addPhotos(count) {
    metricsStore.addPhotos(count);
    this.totalPhotos += count;
  }

  /**
   * Añade un job al historial reciente (máximo RECENT_JOBS_MAX entradas).
   *
   * @param {{ jobId: string, title: string, status: string, error?: string, finishedAt?: string }} job
   */
  _pushRecentJob(job) {
    this.recentJobs.unshift(job);
    if (this.recentJobs.length > config.RECENT_JOBS_MAX) {
      this.recentJobs.pop();
    }
  }

  /**
   * Limpia la referencia al job activo en curso.
   */
  _clearActiveJob() {
    this.currentJob = null;
    this.currentJobStartedAt = null;
    this.activeJobId = null;
  }

  /**
   * Retorna el estado combinado de la cola (métricas de BullMQ + sesión + persistidas).
   *
   * @param {import('bullmq').Queue} queue Instancia de BullMQ Queue
   * @returns {Promise<{pendingCount: number, isProcessing: boolean, totalProcessed: number, totalErrors: number, totalPhotos: number, sessionProcessed: number, sessionErrors: number, sessionPhotos: number, lastJobProcessed: object|null, lastProcessedAt: string|null, currentJob: object|null, currentJobStartedAt: string|null, startedAt: string, recentJobs: Array}>}
   */
  async getStatus(queue) {
    const counts = await queue.getJobCounts('wait', 'active', 'delayed', 'failed');
    const isProcessing = counts.active > 0;
    const store = metricsStore.getMetrics();

    return {
      pendingCount: counts.wait + counts.delayed,
      isProcessing,
      totalProcessed: store.historical.totalProcessed,
      totalErrors: store.historical.totalErrors,
      totalPhotos: store.historical.totalPhotos,
      totalPlanos: store.historical.totalPlanos,
      sessionProcessed: store.session.processed,
      sessionErrors: store.session.errors,
      sessionPhotos: store.session.photos,
      sessionPlanos: store.session.planos,
      sessionRejectedByExtension: store.session.rejectedByExtension,
      planoStalledCycles: this.planoStalledCycles,
      lastJobProcessed: this.lastJobProcessed,
      lastProcessedAt: this.lastProcessedAt,
      currentJob: this.currentJob,
      currentJobStartedAt: this.currentJobStartedAt,
      startedAt: this.startedAt,
      recentJobs: this.recentJobs
    };
  }
}

const metricsTracker = new MetricsTracker();

module.exports = { MetricsTracker, metricsTracker };