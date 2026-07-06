import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const mockFrom = vi.fn();
const mockUpload = vi.fn();
const mockExists = vi.fn();
const mockRemove = vi.fn();

const mockStorageFrom = vi.fn(() => ({
  upload: mockUpload,
  exists: mockExists,
  remove: mockRemove,
}));

const mockSupabase = {
  from: (table) => mockFrom(table),
  storage: { from: mockStorageFrom },
};

const mockMetricsTracker = {
  addPlanos: vi.fn(),
};

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
injectMock('../../src/jobs/metrics-tracker', { metricsTracker: mockMetricsTracker });
injectMock('../../src/utils/redis-connection', { connection: {}, getRedisConnection: vi.fn() });

const clearPlanoUploaderCache = () => {
  const resolved = require.resolve('../../src/services/plano-uploader');
  const resolvedLower = resolved.toLowerCase();
  for (const key of Object.keys(require.cache)) {
    if (key.toLowerCase() === resolvedLower) {
      delete require.cache[key];
    }
  }
};
clearPlanoUploaderCache();

const {
  processJobPlano,
  listMatchingPdfs,
  selectPlanoPdfs,
  parsePlansUrl,
  validatePdfBuffer,
  normalizeAscii,
  buildProjectFolderIndex,
  getProjectFolderIndex,
  invalidateProjectFolderIndex,
} = require('../../src/services/plano-uploader');

const config = require('../../src/config');

const PLACEHOLDER_BASE = path.resolve('./test_trabajos_placeholder');
const PROJECT_FOLDER = path.join(PLACEHOLDER_BASE, '1ACTIVOS', 'P260251 - Test');
const FABRICACION = path.join(PROJECT_FOLDER, 'FABRICACION');

const VALID_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\n%%EOF\n',
  'latin1'
);

async function mkdirIfMissing(p) {
  await fs.promises.mkdir(p, { recursive: true });
}

async function cleanupFabricacion() {
  try {
    await fs.promises.rm(FABRICACION, { recursive: true, force: true });
  } catch {
    // ignorar
  }
}

describe('plano-uploader service', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockFrom.mockReset();
    mockUpload.mockReset();
    mockExists.mockReset();
    mockRemove.mockReset();
    mockMetricsTracker.addPlanos.mockReset();
    mockStorageFrom.mockImplementation(() => ({
      upload: mockUpload,
      exists: mockExists,
      remove: mockRemove,
    }));
  });

  afterEach(async () => {
    await cleanupFabricacion();
  });

  describe('parsePlansUrl', () => {
    it('devuelve [] para null/undefined/empty', () => {
      expect(parsePlansUrl(null)).toEqual([]);
      expect(parsePlansUrl(undefined)).toEqual([]);
      expect(parsePlansUrl('')).toEqual([]);
      expect(parsePlansUrl('   ')).toEqual([]);
    });

    it('parsea un array JSON de objetos {name, path}', () => {
      const input = JSON.stringify([
        { name: 'P260251 - a.pdf', path: 'planos_job1_P260251 - a.pdf' },
        { name: 'P260251 - b.pdf', path: 'planos_job1_P260251 - b.pdf' },
      ]);
      const result = parsePlansUrl(input);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ name: 'P260251 - a.pdf', path: 'planos_job1_P260251 - a.pdf' });
    });

    it('trata un string suelto (legacy) como [{name: null, path: <string>}]', () => {
      const result = parsePlansUrl('planos_cafa4698-f651-434f-8ab8-3cfc07701433.pdf');
      expect(result).toEqual([{ name: null, path: 'planos_cafa4698-f651-434f-8ab8-3cfc07701433.pdf' }]);
    });

    it('devuelve [] si el JSON está corrupto', () => {
      expect(parsePlansUrl('[{broken json')).toEqual([]);
    });

    it('acepta un array de strings (los envuelve como {name: null, path})', () => {
      const result = parsePlansUrl(JSON.stringify(['planos_x_1.pdf', 'planos_x_2.pdf']));
      expect(result).toEqual([
        { name: null, path: 'planos_x_1.pdf' },
        { name: null, path: 'planos_x_2.pdf' },
      ]);
    });
  });

  describe('normalizeAscii', () => {
    it('strips acentos del español (ÁÉÍÓÚ, Ñ, Ç, Ü)', () => {
      expect(normalizeAscii('RÓTULO')).toBe('ROTULO');
      expect(normalizeAscii('QUIRÓN PREVENCIÓN')).toBe('QUIRON PREVENCION');
      expect(normalizeAscii('SABIÑANIGO')).toBe('SABINANIGO');
      expect(normalizeAscii('PROVENÇA')).toBe('PROVENCA');
      expect(normalizeAscii('BENALMÁDENA')).toBe('BENALMADENA');
      expect(normalizeAscii('PLAFÓN')).toBe('PLAFON');
      expect(normalizeAscii('CAMPIÑA')).toBe('CAMPINA');
      expect(normalizeAscii('GÜIMAR')).toBe('GUIMAR');
    });

    it('no altera ASCII puro', () => {
      expect(normalizeAscii('P260086 - GABANA AMPLIACION')).toBe('P260086 - GABANA AMPLIACION');
    });

    it('devuelve string vacío para input no-string', () => {
      expect(normalizeAscii(null)).toBe('');
      expect(normalizeAscii(undefined)).toBe('');
      expect(normalizeAscii(123)).toBe('');
    });
  });

  describe('validatePdfBuffer', () => {
    it('acepta un PDF válido con %PDF- y %%EOF', () => {
      expect(() => validatePdfBuffer(VALID_PDF)).not.toThrow();
    });

    it('rechaza un buffer vacío', () => {
      expect(() => validatePdfBuffer(Buffer.alloc(0))).toThrow(/0 bytes/);
    });

    it('rechaza un archivo que no empieza con %PDF-', () => {
      const fake = Buffer.from('NOTAPDF\n%%EOF\n', 'latin1');
      expect(() => validatePdfBuffer(fake)).toThrow(/no es un PDF válido/);
    });

    it('rechaza un PDF truncado sin %%EOF', () => {
      const truncated = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n', 'latin1');
      expect(() => validatePdfBuffer(truncated)).toThrow(/truncado o incompleto/);
    });
  });

  describe('listMatchingPdfs', () => {
    it('devuelve solo los PDFs que empiezan por el P-code (case-insensitive)', async () => {
      await mkdirIfMissing(FABRICACION);
      await fs.promises.writeFile(path.join(FABRICACION, 'P260251 - plano1.pdf'), VALID_PDF);
      await fs.promises.writeFile(path.join(FABRICACION, 'p260251 - plano2.pdf'), VALID_PDF);
      await fs.promises.writeFile(path.join(FABRICACION, 'otro.pdf'), VALID_PDF);
      await fs.promises.writeFile(path.join(FABRICACION, 'nota.txt'), 'texto');

      const pdfs = await listMatchingPdfs(FABRICACION, 'P260251');
      expect(pdfs).toHaveLength(2);
      const names = pdfs.map(p => p.name).sort();
      expect(names).toEqual(['P260251 - plano1.pdf', 'p260251 - plano2.pdf']);
    });

    it('devuelve [] si no hay PDFs que matcheen', async () => {
      await mkdirIfMissing(FABRICACION);
      await fs.promises.writeFile(path.join(FABRICACION, 'otro.pdf'), VALID_PDF);

      const pdfs = await listMatchingPdfs(FABRICACION, 'P260251');
      expect(pdfs).toEqual([]);
    });

    it('devuelve [] si la carpeta no existe', async () => {
      const pdfs = await listMatchingPdfs(path.join(FABRICACION, 'no-existe'), 'P260251');
      expect(pdfs).toEqual([]);
    });
  });

  describe('selectPlanoPdfs', () => {
    it('devuelve [] si no hay PDFs nuevos', async () => {
      expect(await selectPlanoPdfs([], 0, 'job-1', 'P260251 - Test')).toEqual([]);
    });

    it('devuelve todos si hay hueco suficiente', async () => {
      const pdfs = [{ name: 'P260251 - a.pdf' }, { name: 'P260251 - b.pdf' }];
      const selected = await selectPlanoPdfs(pdfs, 0, 'job-1', 'P260251 - Test');
      expect(selected).toHaveLength(2);
    });

    it('devuelve [] y alerta si el máximo ya está alcanzado (slots=0)', async () => {
      const orig = config.PLANO_MAX_PLANOS_PER_JOB;
      config.PLANO_MAX_PLANOS_PER_JOB = 4;
      const pdfs = [{ name: 'P260251 - a.pdf' }];
      const selected = await selectPlanoPdfs(pdfs, 4, 'job-1', 'P260251 - Test');
      expect(selected).toEqual([]);
      config.PLANO_MAX_PLANOS_PER_JOB = orig;
    });

    it('recorta a los slots disponibles (ordena alfabético) y alerta los omitidos', async () => {
      const orig = config.PLANO_MAX_PLANOS_PER_JOB;
      config.PLANO_MAX_PLANOS_PER_JOB = 4;
      const pdfs = [{ name: 'P260251 - c.pdf' }, { name: 'P260251 - a.pdf' }, { name: 'P260251 - b.pdf' }];
      const selected = await selectPlanoPdfs(pdfs, 2, 'job-1', 'P260251 - Test');
      expect(selected).toHaveLength(2);
      expect(selected.map(s => s.name)).toEqual(['P260251 - a.pdf', 'P260251 - b.pdf']);
      config.PLANO_MAX_PLANOS_PER_JOB = orig;
    });
  });

  describe('processJobPlano', () => {
    function mockJobSelect(jobData) {
      const mockSingle = vi.fn().mockResolvedValue({ data: jobData, error: null });
      const mockEq = vi.fn().mockReturnValue({ single: mockSingle });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEq });
      mockFrom.mockImplementation((table) => {
        if (table === 'jobs') return { select: mockSelect };
      });
    }

    it('omite si el job ya tiene el máximo de planos (sin readdir)', async () => {
      const plansUrl = JSON.stringify([
        { name: 'P260251 - a.pdf', path: 'planos_j_1.pdf' },
        { name: 'P260251 - b.pdf', path: 'planos_j_2.pdf' },
        { name: 'P260251 - c.pdf', path: 'planos_j_3.pdf' },
        { name: 'P260251 - d.pdf', path: 'planos_j_4.pdf' },
      ]);
      mockJobSelect({ id: 'job-1', title: 'P260251 - Test', plans_url: plansUrl });

      const result = await processJobPlano('job-1', 'P260251 - Test');
      expect(result).toEqual({ skipped: true, reason: 'max_reached' });
      expect(mockUpload).not.toHaveBeenCalled();
    });

    it('omite si no existe la carpeta FABRICACION (no_folder)', async () => {
      mockJobSelect({ id: 'job-1', title: 'P260251 - Test', plans_url: null });
      const result = await processJobPlano('job-1', 'P260251 - Test');
      expect(result).toEqual({ skipped: true, reason: 'no_folder' });
      expect(mockUpload).not.toHaveBeenCalled();
    });

    it('omite si FABRICACION no tiene PDFs que matcheen (no_pdf)', async () => {
      await mkdirIfMissing(FABRICACION);
      await fs.promises.writeFile(path.join(FABRICACION, 'otro.pdf'), VALID_PDF);
      mockJobSelect({ id: 'job-1', title: 'P260251 - Test', plans_url: null });

      const result = await processJobPlano('job-1', 'P260251 - Test');
      expect(result).toEqual({ skipped: true, reason: 'no_pdf' });
      expect(mockUpload).not.toHaveBeenCalled();
    });

    it('omite si todos los planos ya están subidos (up_to_date)', async () => {
      await mkdirIfMissing(FABRICACION);
      await fs.promises.writeFile(path.join(FABRICACION, 'P260251 - plano.pdf'), VALID_PDF);
      const plansUrl = JSON.stringify([{ name: 'P260251 - plano.pdf', path: 'planos_job-1_P260251 - plano.pdf' }]);
      mockJobSelect({ id: 'job-1', title: 'P260251 - Test', plans_url: plansUrl });

      const result = await processJobPlano('job-1', 'P260251 - Test');
      expect(result).toEqual({ skipped: true, reason: 'up_to_date' });
      expect(mockUpload).not.toHaveBeenCalled();
    });

    it('sube 1 plano nuevo (plans_url null) y hace UPDATE con el array', async () => {
      await mkdirIfMissing(FABRICACION);
      await fs.promises.writeFile(path.join(FABRICACION, 'P260251 - plano.pdf'), VALID_PDF);

      const mockSingle = vi.fn().mockResolvedValue({ data: { id: 'job-1', title: 'P260251 - Test', plans_url: null }, error: null });
      const mockEqSelect = vi.fn().mockReturnValue({ single: mockSingle });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEqSelect });

      const mockSelectAfter = vi.fn().mockResolvedValue({ data: [{ id: 'job-1' }], error: null });
      const mockEqPlansUrl = vi.fn().mockReturnValue({ select: mockSelectAfter });
      const mockIsPlansUrl = vi.fn().mockReturnValue({ select: mockSelectAfter });
      const mockEqUpdate = vi.fn().mockReturnValue({ eq: mockEqPlansUrl, is: mockIsPlansUrl });
      const mockUpdate = vi.fn().mockReturnValue({ eq: mockEqUpdate });

      mockFrom.mockImplementation((table) => {
        if (table === 'jobs') return { select: mockSelect, update: mockUpdate };
      });

      mockUpload.mockResolvedValue({ data: { path: 'planos_job-1_P260251 - plano.pdf' }, error: null });
      mockExists.mockResolvedValue({ data: true, error: null });

      const result = await processJobPlano('job-1', 'P260251 - Test');

      expect(result.uploaded).toBe(1);
      expect(mockUpload).toHaveBeenCalledWith(
        'planos_job-1_P260251 - plano.pdf',
        expect.any(Buffer),
        { upsert: true, contentType: 'application/pdf' }
      );
      expect(mockExists).toHaveBeenCalledWith('planos_job-1_P260251 - plano.pdf');
      expect(mockUpdate).toHaveBeenCalled();
      const updateArg = mockUpdate.mock.calls[0][0];
      expect(updateArg).toHaveProperty('plans_url');
      const parsed = JSON.parse(updateArg.plans_url);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].name).toBe('P260251 - plano.pdf');
      expect(parsed[0].path).toBe('planos_job-1_P260251 - plano.pdf');
      expect(mockMetricsTracker.addPlanos).toHaveBeenCalledWith(1);
    });

    it('hace auto-append: sube solo el plano nuevo y preserva los viejos en el array', async () => {
      await mkdirIfMissing(FABRICACION);
      await fs.promises.writeFile(path.join(FABRICACION, 'P260251 - viejo.pdf'), VALID_PDF);
      await fs.promises.writeFile(path.join(FABRICACION, 'P260251 - nuevo.pdf'), VALID_PDF);

      const existingArray = [{ name: 'P260251 - viejo.pdf', path: 'planos_job-1_P260251 - viejo.pdf' }];
      const plansUrl = JSON.stringify(existingArray);

      const mockSingle = vi.fn().mockResolvedValue({ data: { id: 'job-1', title: 'P260251 - Test', plans_url: plansUrl }, error: null });
      const mockEqSelect = vi.fn().mockReturnValue({ single: mockSingle });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEqSelect });

      const mockSelectAfter = vi.fn().mockResolvedValue({ data: [{ id: 'job-1' }], error: null });
      const mockEqPlansUrl = vi.fn().mockReturnValue({ select: mockSelectAfter });
      const mockIsPlansUrl = vi.fn().mockReturnValue({ select: mockSelectAfter });
      const mockEqUpdate = vi.fn().mockReturnValue({ eq: mockEqPlansUrl, is: mockIsPlansUrl });
      const mockUpdate = vi.fn().mockReturnValue({ eq: mockEqUpdate });

      mockFrom.mockImplementation((table) => {
        if (table === 'jobs') return { select: mockSelect, update: mockUpdate };
      });

      mockUpload.mockResolvedValue({ data: {}, error: null });
      mockExists.mockResolvedValue({ data: true, error: null });

      const result = await processJobPlano('job-1', 'P260251 - Test');

      expect(result.uploaded).toBe(1);
      expect(mockUpload).toHaveBeenCalledTimes(1);
      expect(mockUpload).toHaveBeenCalledWith('planos_job-1_P260251 - nuevo.pdf', expect.any(Buffer), expect.any(Object));
      const parsed = JSON.parse(mockUpdate.mock.calls[0][0].plans_url);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].name).toBe('P260251 - viejo.pdf');
      expect(parsed[1].name).toBe('P260251 - nuevo.pdf');
      expect(mockMetricsTracker.addPlanos).toHaveBeenCalledWith(1);
    });

    it('sube hasta el máximo (4) y omite el resto con alerta', async () => {
      const orig = config.PLANO_MAX_PLANOS_PER_JOB;
      config.PLANO_MAX_PLANOS_PER_JOB = 4;
      await mkdirIfMissing(FABRICACION);
      for (let i = 1; i <= 5; i++) {
        await fs.promises.writeFile(path.join(FABRICACION, `P260251 - plano${i}.pdf`), VALID_PDF);
      }

      const mockSingle = vi.fn().mockResolvedValue({ data: { id: 'job-1', title: 'P260251 - Test', plans_url: null }, error: null });
      const mockEqSelect = vi.fn().mockReturnValue({ single: mockSingle });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEqSelect });
      const mockSelectAfter = vi.fn().mockResolvedValue({ data: [{ id: 'job-1' }], error: null });
      const mockEqPlansUrl = vi.fn().mockReturnValue({ select: mockSelectAfter });
      const mockIsPlansUrl = vi.fn().mockReturnValue({ select: mockSelectAfter });
      const mockEqUpdate = vi.fn().mockReturnValue({ eq: mockEqPlansUrl, is: mockIsPlansUrl });
      const mockUpdate = vi.fn().mockReturnValue({ eq: mockEqUpdate });
      mockFrom.mockImplementation((table) => {
        if (table === 'jobs') return { select: mockSelect, update: mockUpdate };
      });
      mockUpload.mockResolvedValue({ data: {}, error: null });
      mockExists.mockResolvedValue({ data: true, error: null });

      const result = await processJobPlano('job-1', 'P260251 - Test');

      expect(result.uploaded).toBe(4);
      expect(mockUpload).toHaveBeenCalledTimes(4);
      const parsed = JSON.parse(mockUpdate.mock.calls[0][0].plans_url);
      expect(parsed).toHaveLength(4);
      config.PLANO_MAX_PLANOS_PER_JOB = orig;
    });

    it('resuelve raza CAS si plans_url fue modificado por otro proceso (race_condition_resolved)', async () => {
      await mkdirIfMissing(FABRICACION);
      await fs.promises.writeFile(path.join(FABRICACION, 'P260251 - nuevo.pdf'), VALID_PDF);

      const existingArray = [{ name: 'P260251 - viejo.pdf', path: 'planos_job-1_viejo.pdf' }];
      const plansUrl = JSON.stringify(existingArray);

      const mockSingle = vi.fn().mockResolvedValue({ data: { id: 'job-1', title: 'P260251 - Test', plans_url: plansUrl }, error: null });
      const mockEqSelect = vi.fn().mockReturnValue({ single: mockSingle });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEqSelect });

      const mockSelectAfter = vi.fn().mockResolvedValue({ data: [], error: null });
      const mockEqPlansUrl = vi.fn().mockReturnValue({ select: mockSelectAfter });
      const mockIsPlansUrl = vi.fn().mockReturnValue({ select: mockSelectAfter });
      const mockEqUpdate = vi.fn().mockReturnValue({ eq: mockEqPlansUrl, is: mockIsPlansUrl });
      const mockUpdate = vi.fn().mockReturnValue({ eq: mockEqUpdate });

      mockFrom.mockImplementation((table) => {
        if (table === 'jobs') return { select: mockSelect, update: mockUpdate };
      });
      mockUpload.mockResolvedValue({ data: {}, error: null });
      mockExists.mockResolvedValue({ data: true, error: null });

      const result = await processJobPlano('job-1', 'P260251 - Test');
      expect(result).toEqual({ skipped: true, reason: 'race_condition_resolved' });
      expect(mockUpload).toHaveBeenCalledTimes(1);
      expect(mockMetricsTracker.addPlanos).not.toHaveBeenCalled();
    });

    it('lanza error si la verificación exists falla (no actualiza BD)', async () => {
      await mkdirIfMissing(FABRICACION);
      await fs.promises.writeFile(path.join(FABRICACION, 'P260251 - plano.pdf'), VALID_PDF);

      const mockSingle = vi.fn().mockResolvedValue({ data: { id: 'job-1', title: 'P260251 - Test', plans_url: null }, error: null });
      const mockEqSelect = vi.fn().mockReturnValue({ single: mockSingle });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEqSelect });
      const mockUpdate = vi.fn();
      mockFrom.mockImplementation((table) => {
        if (table === 'jobs') return { select: mockSelect, update: mockUpdate };
      });
      mockUpload.mockResolvedValue({ data: {}, error: null });
      mockExists.mockResolvedValue({ data: false, error: null });

      await expect(processJobPlano('job-1', 'P260251 - Test'))
        .rejects.toThrow(/Verificación post-subida fallida/);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('lanza error si la subida a Storage falla', async () => {
      await mkdirIfMissing(FABRICACION);
      await fs.promises.writeFile(path.join(FABRICACION, 'P260251 - plano.pdf'), VALID_PDF);
      const mockSingle = vi.fn().mockResolvedValue({ data: { id: 'job-1', title: 'P260251 - Test', plans_url: null }, error: null });
      const mockEqSelect = vi.fn().mockReturnValue({ single: mockSingle });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEqSelect });
      mockFrom.mockImplementation((table) => {
        if (table === 'jobs') return { select: mockSelect };
      });
      mockUpload.mockResolvedValue({ data: null, error: { message: 'Storage error' } });

      await expect(processJobPlano('job-1', 'P260251 - Test'))
        .rejects.toThrow(/Error subiendo plano a Storage/);
    });

    it('rechaza un PDF corrupto (sin %PDF-) no subiéndolo', async () => {
      await mkdirIfMissing(FABRICACION);
      await fs.promises.writeFile(path.join(FABRICACION, 'P260251 - plano.pdf'), Buffer.from('no-es-un-pdf', 'latin1'));
      const mockSingle = vi.fn().mockResolvedValue({ data: { id: 'job-1', title: 'P260251 - Test', plans_url: null }, error: null });
      const mockEqSelect = vi.fn().mockReturnValue({ single: mockSingle });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEqSelect });
      mockFrom.mockImplementation((table) => {
        if (table === 'jobs') return { select: mockSelect };
      });

      await expect(processJobPlano('job-1', 'P260251 - Test'))
        .rejects.toThrow(/no es un PDF válido/);
      expect(mockUpload).not.toHaveBeenCalled();
    });

    it('lanza error si el título no tiene código de proyecto válido', async () => {
      mockJobSelect({ id: 'job-1', title: 'SinCodigo', plans_url: null });
      await expect(processJobPlano('job-1', 'SinCodigo'))
        .rejects.toThrow(/no comienza con un código de proyecto válido/);
    });

    it('falla a seguro si .exists() lanza un error de red (no actualiza BD)', async () => {
      await mkdirIfMissing(FABRICACION);
      await fs.promises.writeFile(path.join(FABRICACION, 'P260251 - plano.pdf'), VALID_PDF);
      const mockSingle = vi.fn().mockResolvedValue({ data: { id: 'job-1', title: 'P260251 - Test', plans_url: null }, error: null });
      const mockEqSelect = vi.fn().mockReturnValue({ single: mockSingle });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEqSelect });
      const mockUpdate = vi.fn();
      mockFrom.mockImplementation((table) => {
        if (table === 'jobs') return { select: mockSelect, update: mockUpdate };
      });
      mockUpload.mockResolvedValue({ data: {}, error: null });
      mockExists.mockRejectedValue(new Error('Network error during HEAD'));

      await expect(processJobPlano('job-1', 'P260251 - Test'))
        .rejects.toThrow(/Verificación post-subida fallida/);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('rechaza un plano que excede el tamaño máximo', async () => {
      const orig = config.PLANO_MAX_SIZE_MB;
      config.PLANO_MAX_SIZE_MB = 1;
      await mkdirIfMissing(FABRICACION);
      const bigBuffer = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2 * 1024 * 1024), Buffer.from('\n%%EOF\n')]);
      await fs.promises.writeFile(path.join(FABRICACION, 'P260251 - plano.pdf'), bigBuffer);
      const mockSingle = vi.fn().mockResolvedValue({ data: { id: 'job-1', title: 'P260251 - Test', plans_url: null }, error: null });
      const mockEqSelect = vi.fn().mockReturnValue({ single: mockSingle });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEqSelect });
      mockFrom.mockImplementation((table) => {
        if (table === 'jobs') return { select: mockSelect };
      });

      await expect(processJobPlano('job-1', 'P260251 - Test'))
        .rejects.toThrow(/excede el límite/);
      expect(mockUpload).not.toHaveBeenCalled();
      config.PLANO_MAX_SIZE_MB = orig;
    });

    it('normaliza acentos en el storage key (Ó→O, Ñ→N, Ç→C) manteniendo el name original', async () => {
      await mkdirIfMissing(FABRICACION);
      await fs.promises.writeFile(path.join(FABRICACION, 'P260251 - RÓTULO SABIÑANIGO PROVENÇA.pdf'), VALID_PDF);

      const mockSingle = vi.fn().mockResolvedValue({ data: { id: 'job-1', title: 'P260251 - Test', plans_url: null }, error: null });
      const mockEqSelect = vi.fn().mockReturnValue({ single: mockSingle });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEqSelect });
      const mockSelectAfter = vi.fn().mockResolvedValue({ data: [{ id: 'job-1' }], error: null });
      const mockEqPlansUrl = vi.fn().mockReturnValue({ select: mockSelectAfter });
      const mockIsPlansUrl = vi.fn().mockReturnValue({ select: mockSelectAfter });
      const mockEqUpdate = vi.fn().mockReturnValue({ eq: mockEqPlansUrl, is: mockIsPlansUrl });
      const mockUpdate = vi.fn().mockReturnValue({ eq: mockEqUpdate });
      mockFrom.mockImplementation((table) => {
        if (table === 'jobs') return { select: mockSelect, update: mockUpdate };
      });
      mockUpload.mockResolvedValue({ data: {}, error: null });
      mockExists.mockResolvedValue({ data: true, error: null });

      const result = await processJobPlano('job-1', 'P260251 - Test');

      expect(result.uploaded).toBe(1);
      expect(mockUpload).toHaveBeenCalledWith(
        'planos_job-1_P260251 - ROTULO SABINANIGO PROVENCA.pdf',
        expect.any(Buffer),
        { upsert: true, contentType: 'application/pdf' }
      );
      const parsed = JSON.parse(mockUpdate.mock.calls[0][0].plans_url);
      expect(parsed[0].name).toBe('P260251 - RÓTULO SABIÑANIGO PROVENÇA.pdf');
      expect(parsed[0].path).toBe('planos_job-1_P260251 - ROTULO SABINANIGO PROVENCA.pdf');
    });
  });

  describe('buildProjectFolderIndex', () => {
    let indexRoot;

    beforeEach(async () => {
      indexRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plano-index-'));
    });

    afterEach(async () => {
      try {
        await fs.promises.rm(indexRoot, { recursive: true, force: true });
      } catch {
        // ignorar
      }
      invalidateProjectFolderIndex();
    });

    async function mkdirp(p) {
      await fs.promises.mkdir(p, { recursive: true });
    }

    it('captura P-codes a profundidad mixta (1, 2, 3, 4) en un solo walk', async () => {
      await mkdirp(path.join(indexRoot, 'P260001 - TopLevel'));
      await mkdirp(path.join(indexRoot, 'SANTANDER', 'P260002 - Depth2'));
      await mkdirp(path.join(indexRoot, 'MAPFRE', 'SUR', 'P260003 - Depth3'));
      await mkdirp(path.join(indexRoot, 'CARREFOUR', 'NORTE', 'ZONA', 'P260004 - Depth4'));

      const index = await buildProjectFolderIndex(indexRoot);

      expect(index.size).toBe(4);
      expect(index.has('P260001')).toBe(true);
      expect(index.has('P260002')).toBe(true);
      expect(index.has('P260003')).toBe(true);
      expect(index.has('P260004')).toBe(true);
    });

    it('no entra en carpetas de proyecto ni en subcarpetas estándar (poda)', async () => {
      await mkdirp(path.join(indexRoot, 'P260010 - Proyecto', 'FOTOS', 'FOTOS TERMINADO'));
      await mkdirp(path.join(indexRoot, 'P260010 - Proyecto', 'FABRICACION'));
      await mkdirp(path.join(indexRoot, 'P260010 - Proyecto', 'DOCUMENTACION'));

      const index = await buildProjectFolderIndex(indexRoot);

      expect(index.size).toBe(1);
      expect(index.get('P260010')).toBe(path.join(indexRoot, 'P260010 - Proyecto'));
    });

    it('conserva el primer P-code duplicado (orden DFS)', async () => {
      await mkdirp(path.join(indexRoot, 'P260020 - Primero'));
      await mkdirp(path.join(indexRoot, 'OTRA', 'P260020 - Duplicado'));

      const index = await buildProjectFolderIndex(indexRoot);

      expect(index.size).toBe(1);
      expect(index.has('P260020')).toBe(true);
    });

    it('devuelve mapa vacío si el directorio no existe', async () => {
      const index = await buildProjectFolderIndex(path.join(indexRoot, 'no-existe'));
      expect(index.size).toBe(0);
    });

    it('getProjectFolderIndex cachea y reutiliza entre llamadas dentro del TTL', async () => {
      await mkdirp(path.join(indexRoot, 'P260040 - Cache'));
      invalidateProjectFolderIndex();

      const index1 = await getProjectFolderIndex(indexRoot);
      const index2 = await getProjectFolderIndex(indexRoot);

      expect(index1).toBe(index2);
      expect(index1.get('P260040')).toBeDefined();
    });
  });
});
