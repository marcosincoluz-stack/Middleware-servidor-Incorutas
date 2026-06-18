import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { getFailedJobs, retryFailedJob, clearFailedJobs } from '../../src/jobs/dlq-handler';

describe('dlq-handler', () => {
  let mockQueue;

  beforeEach(() => {
    vi.clearAllMocks();
    mockQueue = {
      getFailed: vi.fn(),
      getJob: vi.fn(),
      clean: vi.fn().mockResolvedValue([]),
    };
  });

  describe('getFailedJobs', () => {
    it('mapea jobs fallidos de BullMQ correctamente', async () => {
      const mockFailedJob = {
        id: 'job.approved-job-789',
        data: { jobId: 'job-789', title: 'P260251 - Fallido', event: 'job.approved' },
        failedReason: 'Error de descarga',
        finishedOn: 1718450000000,
        processedOn: 1718449000000,
        attemptsMade: 3,
      };
      mockQueue.getFailed.mockResolvedValue([mockFailedJob]);

      const result = await getFailedJobs(mockQueue);

      expect(result).toHaveLength(1);
      expect(result[0].bullJobId).toBe('job.approved-job-789');
      expect(result[0].jobId).toBe('job-789');
      expect(result[0].title).toBe('P260251 - Fallido');
      expect(result[0].event).toBe('job.approved');
      expect(result[0].error).toBe('Error de descarga');
      expect(result[0].attemptsMade).toBe(3);
      expect(result[0]).toHaveProperty('failedAt');
    });

    it('retorna array vacío si no hay jobs fallidos', async () => {
      mockQueue.getFailed.mockResolvedValue([]);

      const result = await getFailedJobs(mockQueue);

      expect(result).toEqual([]);
    });

    it('usa processedOn como fallback cuando finishedOn es null', async () => {
      const mockJob = {
        id: 'job.approved-123',
        data: { jobId: 'job-123', title: 'Test', event: 'job.approved' },
        failedReason: null,
        finishedOn: null,
        processedOn: 1718449000000,
        attemptsMade: 2,
      };
      mockQueue.getFailed.mockResolvedValue([mockJob]);

      const result = await getFailedJobs(mockQueue);

      expect(typeof result[0].failedAt).toBe('string');
    });
  });

  describe('retryFailedJob', () => {
    it('elimina y re-encola un job fallido', async () => {
      const mockJob = {
        id: 'job.approved-job-100',
        data: { jobId: 'job-100', title: 'P260251 - Retry', event: 'job.approved' },
        remove: vi.fn().mockResolvedValue(undefined),
      };
      const mockEnqueue = vi.fn().mockResolvedValue(undefined);
      mockQueue.getJob.mockResolvedValue(mockJob);

      await retryFailedJob(mockQueue, 'job.approved-job-100', mockEnqueue);

      expect(mockJob.remove).toHaveBeenCalled();
      expect(mockEnqueue).toHaveBeenCalledWith('job-100', 'P260251 - Retry', 'job.approved');
    });

    it('lanza error si el job no existe', async () => {
      mockQueue.getJob.mockResolvedValue(null);
      const mockEnqueue = vi.fn();

      await expect(retryFailedJob(mockQueue, 'nonexistent-id', mockEnqueue))
        .rejects.toThrow(/No se encontró el trabajo con ID "nonexistent-id"/);

      expect(mockEnqueue).not.toHaveBeenCalled();
    });
  });

  describe('clearFailedJobs', () => {
    it('llama a queue.clean con parámetros correctos', async () => {
      await clearFailedJobs(mockQueue);

      expect(mockQueue.clean).toHaveBeenCalledWith(0, 0, 'failed');
    });
  });
});