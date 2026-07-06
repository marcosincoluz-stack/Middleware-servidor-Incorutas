import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQueueAdd = vi.fn().mockResolvedValue(undefined);
const mockQueueGetJobCounts = vi.fn().mockResolvedValue({ wait: 0, active: 0, delayed: 0, failed: 0, paused: 0 });
const mockQueueGetJob = vi.fn().mockResolvedValue(null);
const mockQueueClose = vi.fn().mockResolvedValue(undefined);

const workerHandlers = {};
const mockWorkerOn = vi.fn().mockImplementation((event, handler) => {
  workerHandlers[event] = handler;
});
const mockWorkerClose = vi.fn().mockResolvedValue(undefined);

const mockRedisOn = vi.fn();
const mockRedisQuit = vi.fn().mockResolvedValue(undefined);

const injectMock = (modulePath, exportsObject) => {
  const resolved = require.resolve(modulePath);
  const resolvedLower = resolved.toLowerCase();
  let found = false;
  for (const key of Object.keys(require.cache)) {
    if (key.toLowerCase() === resolvedLower) {
      require.cache[key].exports = exportsObject;
      found = true;
    }
  }
  if (!found) {
    require.cache[resolved] = {
      id: resolved,
      filename: resolved,
      loaded: true,
      exports: exportsObject,
    };
  }
};

class MockQueue {
  constructor() {
    this.add = mockQueueAdd;
    this.getJobCounts = mockQueueGetJobCounts;
    this.getJob = mockQueueGetJob;
    this.close = mockQueueClose;
  }
}

let workerHandler = null;

class MockWorker {
  constructor(queueName, handler) {
    workerHandler = handler;
    this.on = mockWorkerOn;
    this.close = mockWorkerClose;
  }
}

class MockQueueEvents {
  constructor() {}
}

injectMock('bullmq', {
  Queue: MockQueue,
  Worker: MockWorker,
  QueueEvents: MockQueueEvents,
});

function MockRedis() {
  this.on = mockRedisOn;
  this.quit = mockRedisQuit;
}
injectMock('ioredis', MockRedis);

const mockProcessJobApproved = vi.fn();
const mockMoveJobToTerminados = vi.fn();
const mockProcessJobPlano = vi.fn();

injectMock('../../src/services/downloader', {
  processJobApproved: mockProcessJobApproved,
  cleanupOrphanedPartFiles: vi.fn().mockResolvedValue(0),
});
injectMock('../../src/services/folder-mover', { moveJobToTerminados: mockMoveJobToTerminados });
injectMock('../../src/services/plano-uploader', { processJobPlano: mockProcessJobPlano });

const mockMetricsTracker = {
  onCompleted: vi.fn(),
  onFailed: vi.fn(),
  addPhotos: vi.fn(),
  getStatus: vi.fn().mockResolvedValue({
    pendingCount: 2,
    isProcessing: true,
    totalProcessed: 10,
    totalErrors: 2,
    totalPhotos: 50,
    sessionProcessed: 3,
    sessionErrors: 1,
    sessionPhotos: 15,
    lastJobProcessed: null,
    lastProcessedAt: null,
    currentJob: null,
    currentJobStartedAt: null,
    startedAt: '2026-01-01T00:00:00Z',
    recentJobs: [],
  }),
};

injectMock('../../src/jobs/metrics-tracker', { metricsTracker: mockMetricsTracker, MetricsTracker: vi.fn(), RECENT_JOBS_MAX: 5 });

const mockGetFailedJobs = vi.fn().mockResolvedValue([]);
const mockRetryFailedJob = vi.fn().mockResolvedValue(undefined);
const mockClearFailedJobs = vi.fn().mockResolvedValue(undefined);

injectMock('../../src/jobs/dlq-handler', {
  getFailedJobs: mockGetFailedJobs,
  retryFailedJob: mockRetryFailedJob,
  clearFailedJobs: mockClearFailedJobs,
});

const clearCache = (pattern) => {
  for (const key of Object.keys(require.cache)) {
    if (key.toLowerCase().includes(pattern.toLowerCase())) {
      delete require.cache[key];
    }
  }
};

clearCache('bull-queue');

const { jobQueue } = require('../../src/jobs/bull-queue');

const getWorkerHandler = (eventName) => workerHandlers[eventName] || null;
const getWorkerFn = () => workerHandler;

describe('bull-queue service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMetricsTracker.getStatus.mockResolvedValue({
      pendingCount: 2,
      isProcessing: true,
      totalProcessed: 10,
      totalErrors: 2,
      totalPhotos: 50,
      sessionProcessed: 3,
      sessionErrors: 1,
      sessionPhotos: 15,
      lastJobProcessed: null,
      lastProcessedAt: null,
      currentJob: null,
      currentJobStartedAt: null,
      startedAt: '2026-01-01T00:00:00Z',
      recentJobs: [],
    });
  });

  it('enqueue() llama a queue.add con datos correctos y jobId unico', async () => {
    await jobQueue.enqueue('job-123', 'P260251 - Test', 'job.approved');

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'sync-task',
      { jobId: 'job-123', title: 'P260251 - Test', event: 'job.approved' },
      expect.objectContaining({
        jobId: 'job.approved-job-123',
        attempts: expect.any(Number),
        backoff: expect.objectContaining({ type: 'exponential' }),
      })
    );
  });

  it('enqueue() genera jobId unico diferente para eventos distintos del mismo job', async () => {
    await jobQueue.enqueue('job-456', 'P260251 - Test', 'job.approved');
    await jobQueue.enqueue('job-456', 'P260251 - Test', 'job.paid');

    expect(mockQueueAdd).toHaveBeenCalledTimes(2);
    expect(mockQueueAdd.mock.calls[0][2].jobId).toBe('job.approved-job-456');
    expect(mockQueueAdd.mock.calls[1][2].jobId).toBe('job.paid-job-456');
  });

  it('enqueue() ignora job duplicado si ya fue completado', async () => {
    const mockExistingJob = {
      getState: vi.fn().mockResolvedValue('completed'),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    mockQueueGetJob.mockResolvedValue(mockExistingJob);

    await jobQueue.enqueue('job-789', 'P260251 - Duplicado', 'job.approved');

    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockExistingJob.getState).toHaveBeenCalled();
    expect(mockExistingJob.remove).not.toHaveBeenCalled();
  });

  it('enqueue() re-encola job.plano tras completed (auto-append) eliminando el viejo', async () => {
    const mockExistingJob = {
      getState: vi.fn().mockResolvedValue('completed'),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    mockQueueGetJob.mockResolvedValue(mockExistingJob);

    await jobQueue.enqueue('job-plano-1', 'P260251 - Plano', 'job.plano');

    expect(mockExistingJob.remove).toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'sync-task',
      { jobId: 'job-plano-1', title: 'P260251 - Plano', event: 'job.plano' },
      expect.objectContaining({ jobId: 'job.plano-job-plano-1' })
    );
  });

  it('enqueue() NO re-encola job.plano si está en estado wait (en progreso)', async () => {
    const mockExistingJob = {
      getState: vi.fn().mockResolvedValue('wait'),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    mockQueueGetJob.mockResolvedValue(mockExistingJob);

    await jobQueue.enqueue('job-plano-2', 'P260251 - Plano', 'job.plano');

    expect(mockExistingJob.remove).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('enqueue() ignora job duplicado si ya está en la cola (estado wait)', async () => {
    const mockExistingJob = {
      getState: vi.fn().mockResolvedValue('wait'),
    };
    mockQueueGetJob.mockResolvedValue(mockExistingJob);

    await jobQueue.enqueue('job-789', 'P260251 - EnCola', 'job.approved');

    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockExistingJob.getState).toHaveBeenCalled();
  });

  it('getPendingCount() suma wait + delayed + paused', async () => {
    mockQueueGetJobCounts.mockResolvedValue({ wait: 3, delayed: 2, paused: 1, active: 0, failed: 0 });

    const count = await jobQueue.getPendingCount();

    expect(count).toBe(6);
    expect(mockQueueGetJobCounts).toHaveBeenCalledWith('wait', 'delayed', 'paused');
  });

  it('getStatus() delega en metricsTracker.getStatus()', async () => {
    const status = await jobQueue.getStatus();

    expect(mockMetricsTracker.getStatus).toHaveBeenCalledWith(jobQueue.queue);
    expect(status.pendingCount).toBe(2);
    expect(status.isProcessing).toBe(true);
    expect(status.totalProcessed).toBe(10);
    expect(status.totalErrors).toBe(2);
    expect(status.totalPhotos).toBe(50);
    expect(status).toHaveProperty('startedAt');
    expect(status).toHaveProperty('recentJobs');
  });

  it('getFailedJobs() delega en dlq-handler.getFailedJobs()', async () => {
    await jobQueue.getFailedJobs();

    expect(mockGetFailedJobs).toHaveBeenCalledWith(jobQueue.queue);
  });

  it('retryFailedJob() delega en dlq-handler.retryFailedJob() con enqueue fn', async () => {
    await jobQueue.retryFailedJob('job.approved-job-100');

    expect(mockRetryFailedJob).toHaveBeenCalledWith(
      jobQueue.queue,
      'job.approved-job-100',
      expect.any(Function)
    );
  });

  it('clearFailedJobs() delega en dlq-handler.clearFailedJobs()', async () => {
    await jobQueue.clearFailedJobs();

    expect(mockClearFailedJobs).toHaveBeenCalledWith(jobQueue.queue);
  });

  it('addPhotosCount() delega en metricsTracker.addPhotos()', () => {
    jobQueue.addPhotosCount(25);

    expect(mockMetricsTracker.addPhotos).toHaveBeenCalledWith(25);
  });

  it('shutdown() cierra worker, queue y conexion Redis', async () => {
    await jobQueue.shutdown();

    expect(mockWorkerClose).toHaveBeenCalled();
    expect(mockQueueClose).toHaveBeenCalled();
    expect(mockRedisQuit).toHaveBeenCalled();
  });

  it('worker event "completed" delega en metricsTracker.onCompleted', () => {
    const completedHandler = getWorkerHandler('completed');
    expect(completedHandler).toBeDefined();

    const mockJob = {
      data: { jobId: 'job-200', title: 'P260251 - Completado' },
    };

    completedHandler(mockJob);

    expect(mockMetricsTracker.onCompleted).toHaveBeenCalledWith(mockJob);
  });

  it('worker event "failed" delega en metricsTracker.onFailed', async () => {
    const failedHandler = getWorkerHandler('failed');
    expect(failedHandler).toBeDefined();

    const mockJob = {
      data: { jobId: 'job-300', title: 'P260251 - Fallido' },
      opts: { attempts: 3 },
      attemptsMade: 3,
    };
    const err = new Error('Error de SMB desconectado');

    await failedHandler(mockJob, err);

    expect(mockMetricsTracker.onFailed).toHaveBeenCalledWith(mockJob, err);
  });

  it('worker event "failed" con null job delega en metricsTracker.onFailed', async () => {
    const failedHandler = getWorkerHandler('failed');

    await failedHandler(null, new Error('Redis connection lost'));

    expect(mockMetricsTracker.onFailed).toHaveBeenCalledWith(null, expect.any(Error));
  });

  it('worker event "error" registra un handler', () => {
    const errorHandler = getWorkerHandler('error');
    expect(errorHandler).toBeDefined();
  });

  it('worker fn dispatcha event "job.plano" a processJobPlano', async () => {
    const workerFn = getWorkerFn();
    expect(workerFn).toBeDefined();

    mockProcessJobPlano.mockResolvedValue({ uploaded: 'planos_x.pdf' });

    const fakeJob = {
      data: { jobId: 'job-plano-1', title: 'P260251 - Test', event: 'job.plano' },
      attemptsMade: 0,
      opts: { attempts: 3 },
    };

    await workerFn(fakeJob);

    expect(mockProcessJobPlano).toHaveBeenCalledWith('job-plano-1', 'P260251 - Test');
  });

  it('worker fn dispatcha event "job.approved" a processJobApproved', async () => {
    const workerFn = getWorkerFn();
    mockProcessJobApproved.mockResolvedValue({ downloaded: 0, skipped: 0 });

    const fakeJob = {
      data: { jobId: 'job-approved-1', title: 'P260251 - Test', event: 'job.approved' },
      attemptsMade: 0,
      opts: { attempts: 3 },
    };

    await workerFn(fakeJob);

    expect(mockProcessJobApproved).toHaveBeenCalledWith('job-approved-1', 'P260251 - Test');
  });

  it('worker fn lanza error ante un evento desconocido', async () => {
    const workerFn = getWorkerFn();

    const fakeJob = {
      data: { jobId: 'job-x', title: 'P260251 - Test', event: 'job.unknown' },
      attemptsMade: 0,
      opts: { attempts: 3 },
    };

    await expect(workerFn(fakeJob)).rejects.toThrow(/Evento desconocido "job.unknown"/);
    expect(mockProcessJobPlano).not.toHaveBeenCalled();
    expect(mockProcessJobApproved).not.toHaveBeenCalled();
  });
});