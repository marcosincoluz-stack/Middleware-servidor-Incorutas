import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';

process.env.TRABAJOS_BASE_PATH = os.tmpdir();

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

const mockStatfs = vi.fn();

injectMock('../../src/config', {
  TRABAJOS_BASE_PATH: os.tmpdir(),
  MIN_DISK_MB: 500,
});

injectMock('../../src/utils/logger', {
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
});

const clearCache = (pattern) => {
  for (const key of Object.keys(require.cache)) {
    if (key.toLowerCase().includes(pattern.toLowerCase())) {
      delete require.cache[key];
    }
  }
};

clearCache('disk');

const fs = require('fs');
vi.spyOn(fs.promises, 'statfs').mockImplementation(mockStatfs);

const { checkDiskSpace } = require('../../src/utils/disk');

describe('disk utils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('debería devolver freeMB e isSafe=true cuando hay espacio suficiente', async () => {
    mockStatfs.mockResolvedValue({
      bavail: 1000000,
      bsize: 4096,
    });

    const result = await checkDiskSpace(os.tmpdir());

    expect(typeof result.freeMB).toBe('number');
    expect(result.freeMB).toBeGreaterThan(0);
    expect(result.isSafe).toBe(true);
  });

  it('debería devolver isSafe=false cuando el espacio está por debajo del mínimo', async () => {
    mockStatfs.mockResolvedValue({
      bavail: 100,
      bsize: 4096,
    });

    const result = await checkDiskSpace(os.tmpdir());

    expect(typeof result.freeMB).toBe('number');
    expect(result.freeMB).toBeLessThan(500);
    expect(result.isSafe).toBe(false);
  });

  it('debería lanzar error si statfs falla', async () => {
    mockStatfs.mockRejectedValue(new Error('ENOENT: no such file or directory'));

    await expect(checkDiskSpace('/ruta/que/no/existe/12345'))
      .rejects.toThrow();
  });

  it('debería calcular freeMB correctamente a partir de bavail y bsize', async () => {
    mockStatfs.mockResolvedValue({
      bavail: 256000,
      bsize: 4096,
    });

    const result = await checkDiskSpace(os.tmpdir());

    const expectedMB = (256000 * 4096) / (1024 * 1024);
    expect(result.freeMB).toBeCloseTo(expectedMB, 1);
  });

  it('debería lanzar error si statfs supera el timeout', async () => {
    mockStatfs.mockImplementation(() => new Promise(() => {}));

    await expect(checkDiskSpace(os.tmpdir(), 200))
      .rejects.toThrow(/Timeout statfs/);
  });
});