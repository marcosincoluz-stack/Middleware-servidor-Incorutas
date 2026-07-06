import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const mockFrom = vi.fn();
const mockDownload = vi.fn();

const mockSupabase = {
  from: (table) => mockFrom(table),
  storage: {
    from: () => ({
      download: (path) => mockDownload(path)
    })
  }
};

const mockCheckDiskSpace = vi.fn();

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
      exports: exportsObject
    };
  }
};

const mockJobQueue = {
  addPhotosCount: vi.fn()
};

const mockMetricsTracker = {
  addPhotos: vi.fn(),
  addRejectedByExtension: vi.fn()
};

injectMock('../../src/services/supabase', { supabase: mockSupabase });
injectMock('../../src/utils/disk', { checkDiskSpace: mockCheckDiskSpace });
injectMock('../../src/jobs/bull-queue', { jobQueue: mockJobQueue });
injectMock('../../src/jobs/metrics-tracker', { metricsTracker: mockMetricsTracker });
injectMock('../../src/utils/redis-connection', { connection: {}, getRedisConnection: vi.fn() });

const clearDownloaderCache = () => {
  const resolved = require.resolve('../../src/services/downloader');
  const resolvedLower = resolved.toLowerCase();
  for (const key of Object.keys(require.cache)) {
    if (key.toLowerCase() === resolvedLower) {
      delete require.cache[key];
    }
  }
};
clearDownloaderCache();

const { processJobApproved, getStoragePath, downloadFileWithRetry, resolveUniqueFilename } = require('../../src/services/downloader');

let retryFailedEvidences;

function loadRetryFailed() {
  clearDownloaderCache();
  const mod = require('../../src/services/downloader');
  retryFailedEvidences = mod.retryFailedEvidences;
}

describe('downloader service', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockFrom.mockReset();
    mockDownload.mockReset();
    mockCheckDiskSpace.mockReset();
    mockJobQueue.addPhotosCount.mockReset();
    mockMetricsTracker.addPhotos.mockReset();
  });

  describe('getStoragePath', () => {
    it('debería extraer la ruta relativa de una URL completa de Supabase Storage', () => {
      const url = 'https://example.supabase.co/storage/v1/object/sign/evidence/123/photo.jpg?token=abc';
      const result = getStoragePath(url);
      expect(result).toBe('123/photo.jpg');
    });

    it('debería extraer la ruta relativa de una URL con /storage/v1/object/public/', () => {
      const url = 'https://example.supabase.co/storage/v1/object/public/evidence/456/image.png';
      const result = getStoragePath(url);
      expect(result).toBe('456/image.png');
    });

    it('debería devolver el path sin query params si no es URL de Supabase', () => {
      const path = 'direct/folder/file.jpg?version=2';
      const result = getStoragePath(path);
      expect(result).toBe('direct/folder/file.jpg');
    });

    it('debería devolver el path tal cual si no tiene query params', () => {
      const path = 'folder/photo.png';
      const result = getStoragePath(path);
      expect(result).toBe('folder/photo.png');
    });

    it('debería devolver string vacío si el input es null o undefined', () => {
      expect(getStoragePath(null)).toBe('');
      expect(getStoragePath(undefined)).toBe('');
    });

    it('debería devolver string vacío si el input es string vacío', () => {
      expect(getStoragePath('')).toBe('');
    });
  });

  describe('processJobApproved', () => {
    it('debería abortar si el job ya ha sido descargado previamente (idempotencia)', async () => {
      const mockSingle = vi.fn().mockResolvedValue({
        data: { downloaded_at: '2026-06-15T10:00:00Z', title: 'P260251 - Test' },
        error: null
      });
      const mockEq = vi.fn().mockReturnValue({ single: mockSingle });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEq });

      mockFrom.mockImplementation((table) => {
        if (table === 'jobs') return { select: mockSelect };
      });

      const result = await processJobApproved('job-123', 'P260251 - Test');
      expect(result).toEqual({ skipped: true, reason: 'already_downloaded' });
      expect(mockFrom).toHaveBeenCalledWith('jobs');
    });

    it('debería abortar si el disco está lleno', async () => {
      mockCheckDiskSpace.mockResolvedValue({ freeMB: 10, isSafe: false });

      const mockSingle = vi.fn().mockResolvedValue({
        data: { downloaded_at: null, title: 'P260251 - Test' },
        error: null
      });
      const mockEq = vi.fn().mockReturnValue({ single: mockSingle });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEq });
      mockFrom.mockImplementation((table) => {
        if (table === 'jobs') return { select: mockSelect };
      });

      await expect(processJobApproved('job-123', 'P260251 - Test'))
        .rejects.toThrow(/Abortando descarga por falta de espacio en disco/);
      expect(mockCheckDiskSpace).toHaveBeenCalled();
    });

    it('debería finalizar con 0 descargas si el job no tiene fotos', async () => {
      const mockSingle = vi.fn().mockResolvedValue({
        data: { downloaded_at: null, title: 'P260251 - Test' },
        error: null
      });
      const mockEqJob = vi.fn().mockReturnValue({ single: mockSingle });
      const mockSelectJob = vi.fn().mockReturnValue({ eq: mockEqJob });

      const mockEqUpdate = vi.fn().mockResolvedValue({ error: null });
      const mockUpdate = vi.fn().mockReturnValue({ eq: mockEqUpdate });

      const mockLimit = vi.fn().mockResolvedValue({ data: [], error: null });
      const mockIs = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockEqEvType = vi.fn().mockReturnValue({ is: mockIs });
      const mockEqEvId = vi.fn().mockReturnValue({ in: mockEqEvType });
      const mockSelectEv = vi.fn().mockReturnValue({ eq: mockEqEvId });

      mockFrom.mockImplementation((table) => {
        if (table === 'jobs') return { select: mockSelectJob, update: mockUpdate };
        if (table === 'evidence') return { select: mockSelectEv };
      });

      mockCheckDiskSpace.mockResolvedValue({ freeMB: 1000, isSafe: true });
      const result = await processJobApproved('job-123', 'P260251 - Test');
      expect(result).toEqual({ downloaded: 0, skipped: 0 });
    });

    it('debería lanzar error si el título no tiene código de proyecto válido', async () => {
      mockCheckDiskSpace.mockResolvedValue({ freeMB: 1000, isSafe: true });

      const mockSingle = vi.fn().mockResolvedValue({
        data: { downloaded_at: null, title: 'SinCodigo' },
        error: null
      });
      const mockEqJob = vi.fn().mockReturnValue({ single: mockSingle });
      const mockSelectJob = vi.fn().mockReturnValue({ eq: mockEqJob });

      const mockLimit = vi.fn().mockResolvedValue({
        data: [{ id: 'ev-1', url: 'photo.jpg', type: 'photo' }],
        error: null
      });
      const mockIs = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockEqType = vi.fn().mockReturnValue({ is: mockIs });
      const mockEqId = vi.fn().mockReturnValue({ in: mockEqType });
      const mockSelectEv = vi.fn().mockReturnValue({ eq: mockEqId });

      mockFrom.mockImplementation((table) => {
        if (table === 'jobs') return { select: mockSelectJob };
        if (table === 'evidence') return { select: mockSelectEv };
      });

      await expect(processJobApproved('job-123', 'SinCodigo'))
        .rejects.toThrow(/no comienza con un código de proyecto válido/);
    });

    it('debería lanzar error si hay fallos y DOWNLOAD_TOLERANCE_PERCENT=0 (por defecto)', async () => {
      const mockSingle = vi.fn().mockResolvedValue({
        data: { downloaded_at: null, title: 'P260251 - Test' },
        error: null
      });
      const mockEqJob = vi.fn().mockReturnValue({ single: mockSingle });
      const mockSelectJob = vi.fn().mockReturnValue({ eq: mockEqJob });

      const evData = [
        { id: 'ev-1', url: 'https://example.supabase.co/storage/v1/object/sign/evidence/123/photo1.jpg?token=abc', type: 'photo' },
        { id: 'ev-2', url: '', type: 'photo' },
      ];
      const mockLimit = vi.fn().mockResolvedValue({ data: evData, error: null });
      const mockIs = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockEqType = vi.fn().mockReturnValue({ is: mockIs });
      const mockEqId = vi.fn().mockReturnValue({ in: mockEqType });
      const mockSelectEv = vi.fn().mockReturnValue({ eq: mockEqId });

      mockFrom.mockImplementation((table) => {
        if (table === 'jobs') return { select: mockSelectJob };
        if (table === 'evidence') return { select: mockSelectEv };
      });

      mockCheckDiskSpace.mockResolvedValue({ freeMB: 1000, isSafe: true });

      await expect(processJobApproved('job-123', 'P260251 - Test'))
        .rejects.toThrow(/Sincronización incompleta/);
    });

    it('debería tolerar fallos parciales si están dentro de DOWNLOAD_TOLERANCE_PERCENT', async () => {
      clearDownloaderCache();

      const mockConfigTolerant = {
        TRABAJOS_BASE_PATH: '/tmp/test_trabajos',
        MIN_DISK_MB: 500,
        IS_DEV_MODE: false,
        DOWNLOAD_MAX_RETRIES: 1,
        DOWNLOAD_RETRY_DELAY_MS: 1,
        MAX_FILE_SIZE_MB: 50,
        MAX_EVIDENCES_PER_JOB: 150,
        DOWNLOAD_TOLERANCE_PERCENT: 50,
        LOCK_PROVIDER: 'memory',
      };
      injectMock('../../src/config', mockConfigTolerant);

      const { processJobApproved: processJobTolerant } = require('../../src/services/downloader');

      const mockSingle = vi.fn().mockResolvedValue({
        data: { downloaded_at: null, title: 'P260251 - Test' },
        error: null
      });
      const mockEqJob = vi.fn().mockReturnValue({ single: mockSingle });
      const mockSelectJob = vi.fn().mockReturnValue({ eq: mockEqJob });

      const mockEqUpdate = vi.fn().mockResolvedValue({ error: null });
      const mockUpdate = vi.fn().mockReturnValue({ eq: mockEqUpdate });

      const evData = [
        { id: 'ev-1', url: '', type: 'photo' },
      ];
      const mockLimit = vi.fn().mockResolvedValue({ data: evData, error: null });
      const mockIs = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockEqType = vi.fn().mockReturnValue({ is: mockIs });
      const mockEqId = vi.fn().mockReturnValue({ in: mockEqType });
      const mockSelectEv = vi.fn().mockReturnValue({ eq: mockEqId });

      mockFrom.mockImplementation((table) => {
        if (table === 'jobs') return { select: mockSelectJob, update: mockUpdate };
        if (table === 'evidence') return { select: mockSelectEv };
      });

      mockCheckDiskSpace.mockResolvedValue({ freeMB: 1000, isSafe: true });

      const result = await processJobTolerant('job-123', 'P260251 - Test');

      expect(result).toHaveProperty('errors');
      expect(result.errors).toBe(1);
      expect(mockUpdate).toHaveBeenCalled();
    });

    it('debería omitir y contar como error si la evidencia no tiene una extensión de imagen permitida', async () => {
      const mockSingle = vi.fn().mockResolvedValue({
        data: { downloaded_at: null, title: 'P260251 - Test' },
        error: null
      });
      const mockEqJob = vi.fn().mockReturnValue({ single: mockSingle });
      const mockSelectJob = vi.fn().mockReturnValue({ eq: mockEqJob });

      const evData = [
        { id: 'ev-1', url: 'https://example.supabase.co/storage/v1/object/sign/evidence/123/document.exe', type: 'photo' },
      ];
      const mockLimit = vi.fn().mockResolvedValue({ data: evData, error: null });
      const mockIs = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockEqType = vi.fn().mockReturnValue({ is: mockIs });
      const mockEqId = vi.fn().mockReturnValue({ in: mockEqType });
      const mockSelectEv = vi.fn().mockReturnValue({ eq: mockEqId });

      mockFrom.mockImplementation((table) => {
        if (table === 'jobs') return { select: mockSelectJob };
        if (table === 'evidence') return { select: mockSelectEv };
      });

      mockCheckDiskSpace.mockResolvedValue({ freeMB: 1000, isSafe: true });

      await expect(processJobApproved('job-123', 'P260251 - Test'))
        .rejects.toThrow(/Sincronización incompleta: 1 fotos fallidas/);
    });
  });

  describe('downloadFileWithRetry — atomic .part download', () => {
    it('debería escribir a archivo .part y renombrar al final en éxito', async () => {
      const tmpDir = path.join(os.tmpdir(), 'test-atomic-success');
      await fs.promises.mkdir(tmpDir, { recursive: true });
      const destFile = path.join(tmpDir, 'photo.jpg');
      const partFile = `${destFile}.part`;

      mockDownload.mockResolvedValue({
        data: { arrayBuffer: async () => {
          const buf = new ArrayBuffer(50);
          return buf;
        }},
        error: null
      });

      const result = await downloadFileWithRetry('123/photo.jpg', destFile);

      expect(result.size).toBe(50);
      expect(fs.existsSync(destFile)).toBe(true);
      expect(fs.existsSync(partFile)).toBe(false);

      fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    });

    it('debería limpiar archivo .part en fallo', async () => {
      const tmpDir = path.join(os.tmpdir(), 'test-atomic-fail');
      await fs.promises.mkdir(tmpDir, { recursive: true });
      const destFile = path.join(tmpDir, 'photo.jpg');
      const partFile = `${destFile}.part`;

      mockDownload.mockRejectedValue(new Error('Network error'));

      await expect(downloadFileWithRetry('123/photo.jpg', destFile))
        .rejects.toThrow(/Fallo tras/);

      expect(fs.existsSync(destFile)).toBe(false);
      expect(fs.existsSync(partFile)).toBe(false);

      fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    });

    it('no debería tratar archivo .part como descarga completa', async () => {
      const tmpDir = path.join(os.tmpdir(), 'test-atomic-partial');
      await fs.promises.mkdir(tmpDir, { recursive: true });
      const destFile = path.join(tmpDir, 'photo.jpg');
      const partFile = `${destFile}.part`;

      await fs.promises.writeFile(partFile, 'partial data');

      expect(fs.existsSync(destFile)).toBe(false);
      expect(fs.existsSync(partFile)).toBe(true);

      mockDownload.mockResolvedValue({
        data: { arrayBuffer: async () => new ArrayBuffer(50) },
        error: null
      });

      const result = await downloadFileWithRetry('123/photo.jpg', destFile);

      expect(result.size).toBe(50);
      expect(fs.existsSync(destFile)).toBe(true);
      expect(fs.existsSync(partFile)).toBe(false);

      fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    });
  });

  describe('retryFailedEvidences', () => {
    beforeEach(() => {
      loadRetryFailed();
    });

    it('debería rechazar si el job no existe', async () => {
      const mockSingle = vi.fn().mockResolvedValue({ data: null, error: { message: 'not found' } });
      const mockEq = vi.fn().mockReturnValue({ single: mockSingle });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEq });
      mockFrom.mockImplementation((table) => {
        if (table === 'jobs') return { select: mockSelect };
      });

      await expect(retryFailedEvidences('job-404'))
        .rejects.toThrow(/not found/);
    });

    it('debería rechazar si el job no ha sido descargado previamente', async () => {
      const mockSingle = vi.fn().mockResolvedValue({
        data: { id: 'job-1', title: 'P260251 - Test', downloaded_at: null },
        error: null
      });
      const mockEq = vi.fn().mockReturnValue({ single: mockSingle });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEq });
      mockFrom.mockImplementation((table) => {
        if (table === 'jobs') return { select: mockSelect };
      });

      await expect(retryFailedEvidences('job-1'))
        .rejects.toThrow(/no ha sido descargado previamente/);
    });

    it('debería devolver ceros si no hay fotos fallidas', async () => {
      const mockSingle = vi.fn().mockResolvedValue({
        data: { id: 'job-1', title: 'P260251 - Test', downloaded_at: '2026-06-15T10:00:00Z' },
        error: null
      });
      const mockEqJob = vi.fn().mockReturnValue({ single: mockSingle });
      const mockSelectJob = vi.fn().mockReturnValue({ eq: mockEqJob });

      const mockLimit = vi.fn().mockResolvedValue({ data: [], error: null });
      const mockIsNull = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockEqType = vi.fn().mockReturnValue({ is: mockIsNull });
      const mockEqId = vi.fn().mockReturnValue({ in: mockEqType });
      const mockSelectEv = vi.fn().mockReturnValue({ eq: mockEqId });

      mockFrom.mockImplementation((table) => {
        if (table === 'jobs') return { select: mockSelectJob };
        if (table === 'evidence') return { select: mockSelectEv };
      });

      const result = await retryFailedEvidences('job-1');
      expect(result).toEqual({ retried: 0, succeeded: 0, stillFailed: 0 });
    });

    it('debería recuperar fotos fallidas y actualizar local_path', async () => {
      const mockSingle = vi.fn().mockResolvedValue({
        data: { id: 'job-1', title: 'P260251 - Test', downloaded_at: '2026-06-15T10:00:00Z' },
        error: null
      });
      const mockEqJob = vi.fn().mockReturnValue({ single: mockSingle });
      const mockSelectJob = vi.fn().mockReturnValue({ eq: mockEqJob });

      const mockEqUpdate = vi.fn().mockResolvedValue({ error: null });
      const mockUpdate = vi.fn().mockReturnValue({ eq: mockEqUpdate });

      const failedEvs = [
        { id: 'ev-1', url: 'https://example.supabase.co/storage/v1/object/sign/evidence/123/photo1.jpg?token=abc', type: 'photo' },
      ];
      const mockLimit = vi.fn().mockResolvedValue({ data: failedEvs, error: null });
      const mockIsNull = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockEqType = vi.fn().mockReturnValue({ is: mockIsNull });
      const mockEqId = vi.fn().mockReturnValue({ in: mockEqType });
      const mockSelectEv = vi.fn().mockReturnValue({ eq: mockEqId });

      mockFrom.mockImplementation((table) => {
        if (table === 'jobs') return { select: mockSelectJob };
        if (table === 'evidence') return { select: mockSelectEv, update: mockUpdate };
      });

      mockDownload.mockResolvedValue({
        data: { arrayBuffer: async () => new ArrayBuffer(100) },
        error: null
      });

      const result = await retryFailedEvidences('job-1');
      expect(result.retried).toBe(1);
      expect(result.succeeded).toBe(1);
      expect(result.stillFailed).toBe(0);
      expect(mockUpdate).toHaveBeenCalled();
      expect(mockMetricsTracker.addPhotos).toHaveBeenCalledWith(1);
    });

    it('debería contar stillFailed si la foto sigue fallando', async () => {
      const mockSingle = vi.fn().mockResolvedValue({
        data: { id: 'job-1', title: 'P260252 - StillFailed', downloaded_at: '2026-06-15T10:00:00Z' },
        error: null
      });
      const mockEqJob = vi.fn().mockReturnValue({ single: mockSingle });
      const mockSelectJob = vi.fn().mockReturnValue({ eq: mockEqJob });

      const failedEvs = [
        { id: 'ev-stillfail', url: 'https://example.supabase.co/storage/v1/object/sign/evidence/999/stillfail.jpg?token=abc', type: 'photo' },
      ];
      const mockLimit = vi.fn().mockResolvedValue({ data: failedEvs, error: null });
      const mockIsNull = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockEqType = vi.fn().mockReturnValue({ is: mockIsNull });
      const mockEqId = vi.fn().mockReturnValue({ in: mockEqType });
      const mockSelectEv = vi.fn().mockReturnValue({ eq: mockEqId });

      mockFrom.mockImplementation((table) => {
        if (table === 'jobs') return { select: mockSelectJob };
        if (table === 'evidence') return { select: mockSelectEv };
      });

      mockDownload.mockRejectedValue(new Error('Storage error'));

      const result = await retryFailedEvidences('job-1');
      expect(result.retried).toBe(1);
      expect(result.succeeded).toBe(0);
      expect(result.stillFailed).toBe(1);
    });

    it('debería omitir y contar como stillFailed si la foto tiene una extensión no permitida', async () => {
      const mockSingle = vi.fn().mockResolvedValue({
        data: { id: 'job-1', title: 'P260251 - Test', downloaded_at: '2026-06-15T10:00:00Z' },
        error: null
      });
      const mockEqJob = vi.fn().mockReturnValue({ single: mockSingle });
      const mockSelectJob = vi.fn().mockReturnValue({ eq: mockEqJob });

      const failedEvs = [
        { id: 'ev-1', url: 'https://example.supabase.co/storage/v1/object/sign/evidence/123/document.exe', type: 'photo' },
      ];
      const mockLimit = vi.fn().mockResolvedValue({ data: failedEvs, error: null });
      const mockIsNull = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockEqType = vi.fn().mockReturnValue({ is: mockIsNull });
      const mockEqId = vi.fn().mockReturnValue({ in: mockEqType });
      const mockSelectEv = vi.fn().mockReturnValue({ eq: mockEqId });

      mockFrom.mockImplementation((table) => {
        if (table === 'jobs') return { select: mockSelectJob };
        if (table === 'evidence') return { select: mockSelectEv };
      });

      const result = await retryFailedEvidences('job-1');
      expect(result.retried).toBe(1);
      expect(result.succeeded).toBe(0);
      expect(result.stillFailed).toBe(1);
      expect(mockMetricsTracker.addRejectedByExtension).toHaveBeenCalledWith(1);
    });

    it('debería contar url inválida como stillFailed', async () => {
      const mockSingle = vi.fn().mockResolvedValue({
        data: { id: 'job-1', title: 'P260251 - Test', downloaded_at: '2026-06-15T10:00:00Z' },
        error: null
      });
      const mockEqJob = vi.fn().mockReturnValue({ single: mockSingle });
      const mockSelectJob = vi.fn().mockReturnValue({ eq: mockEqJob });

      const failedEvs = [
        { id: 'ev-1', url: '', type: 'photo' },
      ];
      const mockLimit = vi.fn().mockResolvedValue({ data: failedEvs, error: null });
      const mockIsNull = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockEqType = vi.fn().mockReturnValue({ is: mockIsNull });
      const mockEqId = vi.fn().mockReturnValue({ in: mockEqType });
      const mockSelectEv = vi.fn().mockReturnValue({ eq: mockEqId });

      mockFrom.mockImplementation((table) => {
        if (table === 'jobs') return { select: mockSelectJob };
        if (table === 'evidence') return { select: mockSelectEv };
      });

      const result = await retryFailedEvidences('job-1');
      expect(result.retried).toBe(1);
      expect(result.stillFailed).toBe(1);
    });

    it('NO debería modificar downloaded_at ni crear jobs en BullMQ', async () => {
      const mockSingle = vi.fn().mockResolvedValue({
        data: { id: 'job-1', title: 'P260253 - NoBull', downloaded_at: '2026-06-15T10:00:00Z' },
        error: null
      });
      const mockEqJob = vi.fn().mockReturnValue({ single: mockSingle });
      const mockSelectJob = vi.fn().mockReturnValue({ eq: mockEqJob });

      const mockEqUpdate = vi.fn().mockResolvedValue({ error: null });
      const mockUpdate = vi.fn().mockReturnValue({ eq: mockEqUpdate });

      const failedEvs = [
        { id: 'ev-nobull', url: 'https://example.supabase.co/storage/v1/object/sign/evidence/888/nobull.jpg?token=abc', type: 'photo' },
      ];
      const mockLimit = vi.fn().mockResolvedValue({ data: failedEvs, error: null });
      const mockIsNull = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockEqType = vi.fn().mockReturnValue({ is: mockIsNull });
      const mockEqId = vi.fn().mockReturnValue({ in: mockEqType });
      const mockSelectEv = vi.fn().mockReturnValue({ eq: mockEqId });

      let jobsUpdateCalled = false;
      mockFrom.mockImplementation((table) => {
        if (table === 'jobs') {
          return {
            select: mockSelectJob,
            update: (...args) => { jobsUpdateCalled = true; return mockUpdate(...args); }
          };
        }
        if (table === 'evidence') return { select: mockSelectEv, update: mockUpdate };
      });

      mockDownload.mockResolvedValue({
        data: { arrayBuffer: async () => new ArrayBuffer(100) },
        error: null
      });

      await retryFailedEvidences('job-1');

      expect(jobsUpdateCalled).toBe(false);
      expect(mockMetricsTracker.addPhotos).toHaveBeenCalledWith(1);
    });
  });

  describe('resolveUniqueFilename', () => {
    it('debería devolver el nombre original si no hay colisión', async () => {
      const tmpDir = path.join(os.tmpdir(), 'test-unique-no-collision');
      await fs.promises.mkdir(tmpDir, { recursive: true });

      const result = await resolveUniqueFilename(tmpDir, 'photo.jpg');
      expect(result).toBe(path.join(tmpDir, 'photo.jpg'));

      fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    });

    it('debería añadir (1) si el archivo ya existe', async () => {
      const tmpDir = path.join(os.tmpdir(), 'test-unique-collision');
      await fs.promises.mkdir(tmpDir, { recursive: true });
      await fs.promises.writeFile(path.join(tmpDir, 'photo.jpg'), 'existing');

      const result = await resolveUniqueFilename(tmpDir, 'photo.jpg');
      expect(path.basename(result)).toBe('photo (1).jpg');

      fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    });

    it('debería añadir (2) si (1) también existe', async () => {
      const tmpDir = path.join(os.tmpdir(), 'test-unique-double');
      await fs.promises.mkdir(tmpDir, { recursive: true });
      await fs.promises.writeFile(path.join(tmpDir, 'photo.jpg'), 'a');
      await fs.promises.writeFile(path.join(tmpDir, 'photo (1).jpg'), 'b');

      const result = await resolveUniqueFilename(tmpDir, 'photo.jpg');
      expect(path.basename(result)).toBe('photo (2).jpg');

      fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    });
  });

  describe('cleanupOrphanedPartFiles', () => {
    it('debería eliminar archivos .part en subdirectorios', async () => {
      const tmpBase = path.join(os.tmpdir(), 'test-cleanup-part');
      const activosDir = path.join(tmpBase, '1ACTIVOS');
      const projectDir = path.join(activosDir, 'P260251 - Test', 'FOTOS', 'FOTOS TERMINADO');
      await fs.promises.mkdir(projectDir, { recursive: true });

      const partFile = path.join(projectDir, 'photo.jpg.part');
      const realFile = path.join(projectDir, 'photo.jpg');
      await fs.promises.writeFile(partFile, 'partial');
      await fs.promises.writeFile(realFile, 'complete');

      clearDownloaderCache();
      const mockConfig = {
        TRABAJOS_BASE_PATH: tmpBase,
        MIN_DISK_MB: 500,
        IS_DEV_MODE: false,
        DOWNLOAD_MAX_RETRIES: 1,
        DOWNLOAD_RETRY_DELAY_MS: 1,
        MAX_FILE_SIZE_MB: 50,
        MAX_EVIDENCES_PER_JOB: 150,
        DOWNLOAD_TOLERANCE_PERCENT: 0,
        LOCK_PROVIDER: 'memory',
        SUPABASE_BUCKET: 'evidence',
        DISK_CHECK_INTERVAL: 10,
        MAX_COLLISIONS: 100,
      };
      injectMock('../../src/config', mockConfig);
      const { cleanupOrphanedPartFiles } = require('../../src/services/downloader');

      const cleaned = await cleanupOrphanedPartFiles();

      expect(cleaned).toBe(1);
      expect(fs.existsSync(partFile)).toBe(false);
      expect(fs.existsSync(realFile)).toBe(true);

      fs.promises.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
    });

    it('debería devolver 0 si no hay .part files', async () => {
      const tmpBase = path.join(os.tmpdir(), 'test-cleanup-empty');
      const activosDir = path.join(tmpBase, '1ACTIVOS');
      await fs.promises.mkdir(activosDir, { recursive: true });

      clearDownloaderCache();
      const mockConfig = {
        TRABAJOS_BASE_PATH: tmpBase,
        MIN_DISK_MB: 500,
        IS_DEV_MODE: false,
        DOWNLOAD_MAX_RETRIES: 1,
        DOWNLOAD_RETRY_DELAY_MS: 1,
        MAX_FILE_SIZE_MB: 50,
        MAX_EVIDENCES_PER_JOB: 150,
        DOWNLOAD_TOLERANCE_PERCENT: 0,
        LOCK_PROVIDER: 'memory',
        SUPABASE_BUCKET: 'evidence',
        DISK_CHECK_INTERVAL: 10,
        MAX_COLLISIONS: 100,
      };
      injectMock('../../src/config', mockConfig);
      const { cleanupOrphanedPartFiles } = require('../../src/services/downloader');

      const cleaned = await cleanupOrphanedPartFiles();
      expect(cleaned).toBe(0);

      fs.promises.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
    });
  });

  describe('resolveProjectPhotosFolder', () => {
    it('debería encontrar una carpeta de proyecto anidada a profundidad 3 y no entrar en subcarpetas de proyectos excluidos', async () => {
      const tmpBase = path.join(os.tmpdir(), 'test-recursive-depth');
      const activosDir = path.join(tmpBase, '1ACTIVOS');
      // Estructura: 1ACTIVOS/SANTANDER/1_rotulos/P260999 - Test Profundo
      const deepProjectDir = path.join(activosDir, 'SANTANDER', '1_rotulos', 'P260999 - Test Profundo');
      await fs.promises.mkdir(deepProjectDir, { recursive: true });

      // También creamos una carpeta excluida (FOTOS) dentro de otro proyecto para verificar que no entra ahí
      const otherProjectDir = path.join(activosDir, 'P250001 - Other');
      const fotosExcluidasDir = path.join(otherProjectDir, 'FOTOS', 'P260999 - Fake');
      await fs.promises.mkdir(fotosExcluidasDir, { recursive: true });

      clearDownloaderCache();
      const mockConfig = {
        TRABAJOS_BASE_PATH: tmpBase,
        MIN_DISK_MB: 500,
        IS_DEV_MODE: false,
        DOWNLOAD_MAX_RETRIES: 1,
        DOWNLOAD_RETRY_DELAY_MS: 1,
        MAX_FILE_SIZE_MB: 50,
        MAX_EVIDENCES_PER_JOB: 150,
        DOWNLOAD_TOLERANCE_PERCENT: 0,
        LOCK_PROVIDER: 'memory',
        SUPABASE_BUCKET: 'evidence',
        DISK_CHECK_INTERVAL: 10,
        MAX_COLLISIONS: 100,
      };
      injectMock('../../src/config', mockConfig);

      const { resolveProjectPhotosFolder } = require('../../src/services/downloader');

      const result = await resolveProjectPhotosFolder('P260999 - Test Profundo');
      
      // Debe haber resuelto la ruta dentro de SANTANDER/1_rotulos y NO dentro de P250001/FOTOS
      expect(result).toContain(path.join('SANTANDER', '1_rotulos', 'P260999 - Test Profundo', 'FOTOS', 'FOTOS TERMINADO'));
      expect(result).not.toContain('P250001 - Other');

      // Limpieza
      await fs.promises.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
    });
  });
});