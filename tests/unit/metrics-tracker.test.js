import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockIncrementProcessed = vi.fn();
const mockIncrementErrors = vi.fn();
const mockAddPhotos = vi.fn();
const mockGetMetrics = vi.fn().mockReturnValue({
  historical: { totalProcessed: 10, totalErrors: 2, totalPhotos: 50, firstStartedAt: '2026-01-01T00:00:00Z' },
  session: { processed: 3, errors: 1, photos: 15 },
});

const mockAlertLowDisk = vi.fn().mockResolvedValue(false);
const mockAlertSmbDisconnected = vi.fn().mockResolvedValue(false);
const mockAlertJobFailed = vi.fn().mockResolvedValue(false);

const mockCheckDiskSpace = vi.fn().mockResolvedValue({ freeMB: 500, isSafe: true });

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

injectMock('../../src/utils/metrics-store', {
  metricsStore: {
    incrementProcessed: mockIncrementProcessed,
    incrementErrors: mockIncrementErrors,
    addPhotos: mockAddPhotos,
    getMetrics: mockGetMetrics,
  },
});

injectMock('../../src/utils/notify', {
  alertLowDisk: mockAlertLowDisk,
  alertSmbDisconnected: mockAlertSmbDisconnected,
  alertJobFailed: mockAlertJobFailed,
  send: vi.fn().mockResolvedValue(false),
});

injectMock('../../src/utils/disk', {
  checkDiskSpace: mockCheckDiskSpace,
});

injectMock('../../src/utils/logger', {
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
});

injectMock('../../src/config', {
  MIN_DISK_MB: 500,
  TRABAJOS_BASE_PATH: '/mnt/smb',
  JOB_MAX_RETRIES: 3,
  RECENT_JOBS_MAX: 5,
});

injectMock('../../src/jobs/error-classifier', {
  classifyError: vi.fn((err) => {
    const msg = err.message;
    if (msg.includes('espacio en disco') || msg.includes('ENOSPC')) {
      return { type: 'disk_full', action: 'alert_disk' };
    }
    if (msg.includes('1ACTIVOS') || msg.includes('TRABAJOS_BASE_PATH') || msg.includes('readdir') || msg.includes('SMB')) {
      return { type: 'smb_disconnected', action: 'alert_smb' };
    }
    return { type: 'unknown', action: 'none' };
  }),
  ERROR_PATTERNS: {
    DISK_FULL: ['espacio en disco', 'ENOSPC'],
    SMB_DISCONNECTED: ['1ACTIVOS', 'TRABAJOS_BASE_PATH', 'readdir', 'SMB'],
  },
});

const clearCache = (pattern) => {
  for (const key of Object.keys(require.cache)) {
    if (key.toLowerCase().includes(pattern.toLowerCase())) {
      delete require.cache[key];
    }
  }
};

clearCache('metrics-tracker');

const { MetricsTracker } = require('../../src/jobs/metrics-tracker');

const RECENT_JOBS_MAX = 5;

describe('metrics-tracker', () => {
  let tracker;

  beforeEach(() => {
    vi.clearAllMocks();
    tracker = new MetricsTracker();
  });

  describe('constructor', () => {
    it('inicializa métricas en cero', () => {
      expect(tracker.totalProcessed).toBe(0);
      expect(tracker.totalErrors).toBe(0);
      expect(tracker.totalPhotos).toBe(0);
      expect(tracker.lastJobProcessed).toBeNull();
      expect(tracker.lastProcessedAt).toBeNull();
      expect(tracker.currentJob).toBeNull();
      expect(tracker.currentJobStartedAt).toBeNull();
      expect(tracker.activeJobId).toBeNull();
      expect(tracker.recentJobs).toEqual([]);
    });

    it('exporta RECENT_JOBS_MAX como constante', () => {
      expect(RECENT_JOBS_MAX).toBe(5);
    });
  });

  describe('onCompleted', () => {
    it('incrementa métricas de procesados y actualiza estado', () => {
      const job = { data: { jobId: 'job-1', title: 'P260251 - Test' } };
      tracker.onCompleted(job);

      expect(mockIncrementProcessed).toHaveBeenCalled();
      expect(tracker.totalProcessed).toBe(1);
      expect(tracker.lastJobProcessed).toEqual({ jobId: 'job-1', title: 'P260251 - Test', status: 'success' });
      expect(tracker.lastProcessedAt).toBeTruthy();
      expect(tracker.currentJob).toBeNull();
    });

    it('añade job al historial reciente', () => {
      const job = { data: { jobId: 'job-1', title: 'P260251 - Test' } };
      tracker.onCompleted(job);

      expect(tracker.recentJobs).toHaveLength(1);
      expect(tracker.recentJobs[0].jobId).toBe('job-1');
      expect(tracker.recentJobs[0].status).toBe('success');
    });
  });

  describe('onFailed', () => {
    it('maneja job null sin incrementar errores', async () => {
      await tracker.onFailed(null, new Error('Redis error'));
      expect(mockIncrementErrors).not.toHaveBeenCalled();
    });

    it('no incrementa errores si hay reintentos pendientes', async () => {
      const job = {
        data: { jobId: 'job-1', title: 'Test' },
        opts: { attempts: 3 },
        attemptsMade: 1,
      };
      await tracker.onFailed(job, new Error('Error temporal'));

      expect(mockIncrementErrors).not.toHaveBeenCalled();
      expect(mockAlertJobFailed).not.toHaveBeenCalled();
    });

    it('incrementa errores y envía alerta cuando se agotan los reintentos', async () => {
      const job = {
        data: { jobId: 'job-1', title: 'P260251 - Test' },
        opts: { attempts: 3 },
        attemptsMade: 3,
      };
      await tracker.onFailed(job, new Error('Error de descarga'));

      expect(mockIncrementErrors).toHaveBeenCalled();
      expect(tracker.totalErrors).toBe(1);
      expect(tracker.lastJobProcessed.status).toBe('failed');
      expect(mockAlertJobFailed).toHaveBeenCalledWith(
        'job-1',
        'P260251 - Test',
        expect.stringContaining('Fallo definitivo tras 3 intentos')
      );
    });

    it('envía alerta de disco lleno cuando el error contiene patron disk_full', async () => {
      const job = {
        data: { jobId: 'job-2', title: 'Test' },
        opts: { attempts: 3 },
        attemptsMade: 3,
      };
      await tracker.onFailed(job, new Error('No hay espacio en disco'));

      expect(mockCheckDiskSpace).toHaveBeenCalled();
      expect(mockAlertLowDisk).toHaveBeenCalled();
    });

    it('envía alerta de disco lleno cuando el error contiene "ENOSPC"', async () => {
      const job = {
        data: { jobId: 'job-3', title: 'Test' },
        opts: { attempts: 3 },
        attemptsMade: 3,
      };
      await tracker.onFailed(job, new Error('Error ENOSPC al escribir'));

      expect(mockCheckDiskSpace).toHaveBeenCalled();
      expect(mockAlertLowDisk).toHaveBeenCalled();
    });

    it('envía alerta SMB cuando el error contiene "1ACTIVOS"', async () => {
      const job = {
        data: { jobId: 'job-4', title: 'Test' },
        opts: { attempts: 3 },
        attemptsMade: 3,
      };
      await tracker.onFailed(job, new Error('No se puede acceder a 1ACTIVOS'));

      expect(mockAlertSmbDisconnected).toHaveBeenCalled();
    });

    it('añade job fallido al historial reciente', async () => {
      const job = {
        data: { jobId: 'job-5', title: 'Test' },
        opts: { attempts: 3 },
        attemptsMade: 3,
      };
      await tracker.onFailed(job, new Error('Error'));

      expect(tracker.recentJobs[0].status).toBe('failed');
      expect(tracker.recentJobs[0].error).toBe('Error');
    });

    it('limpia el job activo después de fallar', async () => {
      const job = {
        data: { jobId: 'job-6', title: 'Test' },
        opts: { attempts: 3 },
        attemptsMade: 1,
      };
      tracker.activeJobId = 'some-id';
      await tracker.onFailed(job, new Error('Temporal'));

      expect(tracker.activeJobId).toBeNull();
    });
  });

  describe('addPhotos', () => {
    it('incrementa métricas de fotos correctamente', () => {
      tracker.addPhotos(25);
      expect(mockAddPhotos).toHaveBeenCalledWith(25);
      expect(tracker.totalPhotos).toBe(25);
    });

    it('acumula conteo de fotos', () => {
      tracker.addPhotos(10);
      tracker.addPhotos(15);
      expect(mockAddPhotos).toHaveBeenCalledTimes(2);
      expect(tracker.totalPhotos).toBe(25);
    });
  });

  describe('_pushRecentJob', () => {
    it('mantiene máximo RECENT_JOBS_MAX entradas', () => {
      for (let i = 0; i < 7; i++) {
        tracker._pushRecentJob({ jobId: `job-${i}`, title: `Job ${i}`, status: 'success' });
      }

      expect(tracker.recentJobs).toHaveLength(RECENT_JOBS_MAX);
      expect(tracker.recentJobs[0].jobId).toBe('job-6');
      expect(tracker.recentJobs[4].jobId).toBe('job-2');
    });

    it('añade jobs nuevos al inicio del array', () => {
      tracker._pushRecentJob({ jobId: 'job-1', title: 'First', status: 'success' });
      tracker._pushRecentJob({ jobId: 'job-2', title: 'Second', status: 'success' });

      expect(tracker.recentJobs[0].jobId).toBe('job-2');
      expect(tracker.recentJobs[1].jobId).toBe('job-1');
    });
  });

  describe('getStatus', () => {
    it('combina métricas de BullMQ y MetricsStore', async () => {
      const mockQueue = {
        getJobCounts: vi.fn().mockResolvedValue({ wait: 2, active: 1, delayed: 0, failed: 0 }),
      };

      const status = await tracker.getStatus(mockQueue);

      expect(status.pendingCount).toBe(2);
      expect(status.isProcessing).toBe(true);
      expect(status.totalProcessed).toBe(10);
      expect(status.totalErrors).toBe(2);
      expect(status.totalPhotos).toBe(50);
      expect(status.sessionProcessed).toBe(3);
      expect(status.sessionErrors).toBe(1);
      expect(status.sessionPhotos).toBe(15);
      expect(status).toHaveProperty('startedAt');
      expect(status).toHaveProperty('recentJobs');
    });
  });
});