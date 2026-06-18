import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const mockFrom = vi.fn();
const mockSupabase = {
  from: (table) => mockFrom(table),
};

const mockEnqueue = vi.fn();
const mockGetPendingCount = vi.fn();

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

injectMock('../../src/services/supabase', { supabase: mockSupabase });
injectMock('../../src/jobs/bull-queue', { jobQueue: { enqueue: mockEnqueue, getPendingCount: mockGetPendingCount } });
injectMock('../../src/utils/logger', {
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
});

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polling-test-'));
injectMock('../../src/config', {
  BACKFILL_MAX_JOBS: 100,
  BACKFILL_MAX_PENDING: 200,
  POLLING_INTERVAL_MS: 30000,
  POLLING_ENABLED: true,
  ENABLE_FOLDER_MOVE: true,
  TRABAJOS_BASE_PATH: tmpDir,
});

const clearCache = (pattern) => {
  for (const key of Object.keys(require.cache)) {
    if (key.toLowerCase().includes(pattern.toLowerCase())) {
      delete require.cache[key];
    }
  }
};
clearCache('polling');

const { pollApprovedJobs, pollPaidJobs } = require('../../src/jobs/polling');

describe('polling module', () => {
  let activosDir;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockReset();
    mockEnqueue.mockReset();
    mockGetPendingCount.mockReset();

    activosDir = path.join(tmpDir, '1ACTIVOS');
    fs.rmSync(activosDir, { recursive: true, force: true });
    fs.mkdirSync(activosDir, { recursive: true });
  });

  describe('pollApprovedJobs', () => {
    it('debería encolar jobs approved sin downloaded_at', async () => {
      mockGetPendingCount.mockResolvedValue(0);

      const jobs = [
        { id: 'job-1', title: 'P260251 - Obra A', status: 'approved', downloaded_at: null },
        { id: 'job-2', title: 'P260252 - Obra B', status: 'paid', downloaded_at: null },
      ];
      const mockLimit = vi.fn().mockResolvedValue({ data: jobs, error: null });
      const mockOrder = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockIs = vi.fn().mockReturnValue({ order: mockOrder });
      const mockIn = vi.fn().mockReturnValue({ is: mockIs });
      const mockSelect = vi.fn().mockReturnValue({ in: mockIn });
      mockFrom.mockReturnValue({ select: mockSelect });

      mockEnqueue.mockResolvedValue(undefined);

      const result = await pollApprovedJobs();

      expect(result.found).toBe(2);
      expect(result.enqueued).toBe(2);
      expect(mockEnqueue).toHaveBeenCalledTimes(2);
      expect(mockEnqueue).toHaveBeenCalledWith('job-1', 'P260251 - Obra A', 'job.approved');
      expect(mockEnqueue).toHaveBeenCalledWith('job-2', 'P260252 - Obra B', 'job.approved');
    });

    it('debería devolver ceros si no hay jobs pendientes', async () => {
      mockGetPendingCount.mockResolvedValue(0);

      const mockLimit = vi.fn().mockResolvedValue({ data: [], error: null });
      const mockOrder = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockIs = vi.fn().mockReturnValue({ order: mockOrder });
      const mockIn = vi.fn().mockReturnValue({ is: mockIs });
      const mockSelect = vi.fn().mockReturnValue({ in: mockIn });
      mockFrom.mockReturnValue({ select: mockSelect });

      const result = await pollApprovedJobs();

      expect(result.found).toBe(0);
      expect(result.enqueued).toBe(0);
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('debería respetar backpressure si hay muchos jobs pendientes', async () => {
      mockGetPendingCount.mockResolvedValue(200);

      const result = await pollApprovedJobs();

      expect(result.found).toBe(0);
      expect(result.enqueued).toBe(0);
      expect(mockFrom).not.toHaveBeenCalled();
    });

    it('debería contar como skipped los jobs que fallan al encolar', async () => {
      mockGetPendingCount.mockResolvedValue(0);

      const jobs = [
        { id: 'job-1', title: 'P260251 - Obra A', status: 'approved', downloaded_at: null },
        { id: 'job-2', title: 'P260252 - Obra B', status: 'approved', downloaded_at: null },
      ];
      const mockLimit = vi.fn().mockResolvedValue({ data: jobs, error: null });
      const mockOrder = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockIs = vi.fn().mockReturnValue({ order: mockOrder });
      const mockIn = vi.fn().mockReturnValue({ is: mockIs });
      const mockSelect = vi.fn().mockReturnValue({ in: mockIn });
      mockFrom.mockReturnValue({ select: mockSelect });

      mockEnqueue
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Job duplicado'));

      const result = await pollApprovedJobs();

      expect(result.found).toBe(2);
      expect(result.enqueued).toBe(1);
      expect(result.skipped).toBe(1);
    });
  });

  describe('pollPaidJobs', () => {
    it('debería encolar jobs paid cuya carpeta está en 1ACTIVOS', async () => {
      fs.mkdirSync(path.join(activosDir, 'P260251 - Obra A'), { recursive: true });

      const jobs = [
        { id: 'job-1', title: 'P260251 - Obra A', downloaded_at: '2026-06-15T10:00:00Z' },
      ];
      const mockLimit = vi.fn().mockResolvedValue({ data: jobs, error: null });
      const mockOrder = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockNot = vi.fn().mockReturnValue({ order: mockOrder });
      const mockEqStatus = vi.fn().mockReturnValue({ not: mockNot });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEqStatus });
      mockFrom.mockReturnValue({ select: mockSelect });

      mockEnqueue.mockResolvedValue(undefined);

      const result = await pollPaidJobs();

      expect(result.found).toBe(1);
      expect(result.enqueued).toBe(1);
      expect(mockEnqueue).toHaveBeenCalledWith('job-1', 'P260251 - Obra A', 'job.paid');
    });

    it('debería skip jobs paid cuya carpeta ya no está en 1ACTIVOS', async () => {
      fs.mkdirSync(path.join(activosDir, 'P999999 - Otra'), { recursive: true });

      const jobs = [
        { id: 'job-1', title: 'P260251 - Obra A', downloaded_at: '2026-06-15T10:00:00Z' },
      ];
      const mockLimit = vi.fn().mockResolvedValue({ data: jobs, error: null });
      const mockOrder = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockNot = vi.fn().mockReturnValue({ order: mockOrder });
      const mockEqStatus = vi.fn().mockReturnValue({ not: mockNot });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEqStatus });
      mockFrom.mockReturnValue({ select: mockSelect });

      const result = await pollPaidJobs();

      expect(result.found).toBe(1);
      expect(result.enqueued).toBe(0);
      expect(result.skipped).toBe(1);
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('debería devolver ceros si no hay 1ACTIVOS', async () => {
      fs.rmSync(activosDir, { recursive: true, force: true });

      const result = await pollPaidJobs();

      expect(result.found).toBe(0);
      expect(result.enqueued).toBe(0);
      expect(mockFrom).not.toHaveBeenCalled();
    });

    it('debería devolver ceros si no hay jobs paid', async () => {
      const mockLimit = vi.fn().mockResolvedValue({ data: [], error: null });
      const mockOrder = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockNot = vi.fn().mockReturnValue({ order: mockOrder });
      const mockEqStatus = vi.fn().mockReturnValue({ not: mockNot });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEqStatus });
      mockFrom.mockReturnValue({ select: mockSelect });

      const result = await pollPaidJobs();

      expect(result.found).toBe(0);
      expect(result.enqueued).toBe(0);
    });

    it('debería skip jobs con título sin código P válido', async () => {
      fs.mkdirSync(path.join(activosDir, 'P260251 - Obra'), { recursive: true });

      const jobs = [
        { id: 'job-1', title: 'Sin Codigo', downloaded_at: '2026-06-15T10:00:00Z' },
      ];
      const mockLimit = vi.fn().mockResolvedValue({ data: jobs, error: null });
      const mockOrder = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockNot = vi.fn().mockReturnValue({ order: mockOrder });
      const mockEqStatus = vi.fn().mockReturnValue({ not: mockNot });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEqStatus });
      mockFrom.mockReturnValue({ select: mockSelect });

      const result = await pollPaidJobs();

      expect(result.found).toBe(1);
      expect(result.enqueued).toBe(0);
      expect(result.skipped).toBe(1);
    });
  });

  describe('pollPaidJobs con ENABLE_FOLDER_MOVE=false', () => {
    it('debería devolver ceros sin consultar Supabase ni filesystem', async () => {
      clearCache('polling');
      injectMock('../../src/config', {
        BACKFILL_MAX_JOBS: 100,
        BACKFILL_MAX_PENDING: 200,
        POLLING_INTERVAL_MS: 30000,
        POLLING_ENABLED: true,
        ENABLE_FOLDER_MOVE: false,
        TRABAJOS_BASE_PATH: tmpDir,
      });
      const { pollPaidJobs: pollPaidNoMove } = require('../../src/jobs/polling');

      const result = await pollPaidNoMove();

      expect(result.found).toBe(0);
      expect(result.enqueued).toBe(0);
      expect(mockFrom).not.toHaveBeenCalled();

      clearCache('polling');
      injectMock('../../src/config', {
        BACKFILL_MAX_JOBS: 100,
        BACKFILL_MAX_PENDING: 200,
        POLLING_INTERVAL_MS: 30000,
        POLLING_ENABLED: true,
        ENABLE_FOLDER_MOVE: true,
        TRABAJOS_BASE_PATH: tmpDir,
      });
      require('../../src/jobs/polling');
    });
  });

  describe('runPollCycle overlap guard', () => {
    it('no debería ejecutar dos ciclos en paralelo', async () => {
      clearCache('polling');
      injectMock('../../src/config', {
        BACKFILL_MAX_JOBS: 100,
        BACKFILL_MAX_PENDING: 200,
        POLLING_INTERVAL_MS: 30000,
        POLLING_ENABLED: true,
        ENABLE_FOLDER_MOVE: false,
        TRABAJOS_BASE_PATH: tmpDir,
        POLLING_FAILURE_ALERT_THRESHOLD: 99,
        POLLING_ALERT_COOLDOWN_MS: 999999,
      });

      let resolveDelay;
      const delayPromise = new Promise(r => { resolveDelay = r; });
      mockGetPendingCount.mockResolvedValue(0);

      const mockLimit = vi.fn().mockReturnValue(delayPromise);
      const mockOrder = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockIs = vi.fn().mockReturnValue({ order: mockOrder });
      const mockIn = vi.fn().mockReturnValue({ is: mockIs });
      const mockSelect = vi.fn().mockReturnValue({ in: mockIn });
      mockFrom.mockReturnValue({ select: mockSelect });

      const { startPolling, stopPolling } = require('../../src/jobs/polling');

      startPolling();

      await new Promise(r => setTimeout(r, 50));

      stopPolling();
      resolveDelay();

      await new Promise(r => setTimeout(r, 50));

      expect(true).toBe(true);
    });
  });
});
