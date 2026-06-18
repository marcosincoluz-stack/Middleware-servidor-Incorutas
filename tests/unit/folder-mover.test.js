import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

const mockFrom = vi.fn();
const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockSingle = vi.fn();

const mockSupabase = {
  from: (table) => {
    mockFrom(table);
    return { select: mockSelect };
  }
};

mockSelect.mockReturnValue({ eq: mockEq });
mockEq.mockReturnValue({ single: mockSingle });

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

injectMock('../../src/services/supabase', { supabase: mockSupabase });

const clearCache = (pattern) => {
  for (const key of Object.keys(require.cache)) {
    if (key.toLowerCase().includes(pattern.toLowerCase())) {
      delete require.cache[key];
    }
  }
};

clearCache('folder-mover');

const { moveJobToTerminados } = require('../../src/services/folder-mover');

function createDirent(name, isDir) {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isSymbolicLink: () => false,
  };
}

describe('folder-mover service', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockSingle.mockResolvedValue({
      data: { downloaded_at: '2026-06-15T10:00:00Z' },
      error: null
    });
  });

  it('debería lanzar un error si el título del trabajo no contiene un prefijo Pxxxxx válido', async () => {
    await expect(moveJobToTerminados('job-123', 'Titulo sin codigo'))
      .rejects.toThrow(/El título del trabajo.*no contiene un código de proyecto válido/);
  });

  it('debería abortar si el directorio 1ACTIVOS no existe', async () => {
    vi.spyOn(fs.promises, 'access').mockRejectedValue(new Error('ENOENT'));
    const result = await moveJobToTerminados('job-123', 'P260251 - Proyecto de Prueba');
    expect(result).toEqual({ moved: false, reason: 'activos_dir_not_found' });
  });

  it('debería mover exitosamente la carpeta si se encuentra y no hay colisiones', async () => {
    vi.spyOn(fs.promises, 'access').mockImplementation(async (p) => {
      if (p.includes('1ACTIVOS')) return undefined;
      throw new Error('ENOENT');
    });

    vi.spyOn(fs.promises, 'readdir').mockResolvedValue([
      createDirent('P260251 - Proyecto de Prueba', true)
    ]);
    const spyRename = vi.spyOn(fs.promises, 'rename').mockResolvedValue(undefined);

    const result = await moveJobToTerminados('job-123', 'P260251 - Proyecto de Prueba');

    expect(result.moved).toBe(true);
    expect(spyRename).toHaveBeenCalled();
  });

  it('debería manejar colisiones en TERMINADOS renombrando a _v2, _v3...', async () => {
    vi.spyOn(fs.promises, 'access').mockImplementation(async (p) => {
      if (p.includes('1ACTIVOS')) return undefined;
      if (p.includes('P260251 - Proyecto de Prueba_v2')) throw new Error('ENOENT');
      if (p.includes('P260251 - Proyecto de Prueba')) return undefined;
      throw new Error('ENOENT');
    });

    vi.spyOn(fs.promises, 'readdir').mockResolvedValue([
      createDirent('P260251 - Proyecto de Prueba', true)
    ]);
    const spyRename = vi.spyOn(fs.promises, 'rename').mockResolvedValue(undefined);

    const result = await moveJobToTerminados('job-123', 'P260251 - Proyecto de Prueba');

    expect(result.moved).toBe(true);
    expect(result.destination).toContain('P260251 - Proyecto de Prueba_v2');
    expect(spyRename).toHaveBeenCalled();
  });

  it('debería lanzar error si se supera el límite de colisiones (MAX_COLLISIONS)', async () => {
    vi.spyOn(fs.promises, 'access').mockResolvedValue(undefined);

    vi.spyOn(fs.promises, 'readdir').mockResolvedValue([
      createDirent('P260251 - Proyecto de Prueba', true)
    ]);

    await expect(moveJobToTerminados('job-123', 'P260251 - Proyecto de Prueba'))
      .rejects.toThrow(/Se superó el límite de 100 colisiones/);
  });

  it('debería ejecutar fallback EXDEV con verificación de integridad y mover a papelera', async () => {
    const sourcePath = 'P260251 - Proyecto de Prueba';

    vi.spyOn(fs.promises, 'access').mockImplementation(async (p) => {
      if (p.includes('1ACTIVOS') && !p.includes('P260251')) return undefined;
      if (p.includes('TERMINADOS') && !p.includes('P260251') && !p.includes('.trash')) {
        return undefined;
      }
      if (p.includes('.trash')) return undefined;
      throw new Error('ENOENT');
    });

    vi.spyOn(fs.promises, 'readdir').mockImplementation(async (p) => {
      if (p.endsWith('1ACTIVOS')) {
        return [createDirent(sourcePath, true)];
      }
      if (p.includes('P260251') && !p.includes('.trash')) {
        return [createDirent('foto1.jpg', false), createDirent('foto2.jpg', false)];
      }
      if (p.endsWith('.trash')) {
        return [];
      }
      return [];
    });

    vi.spyOn(fs.promises, 'stat').mockResolvedValue({ size: 1024 });

    const errEXDEV = new Error('Cross-device link');
    errEXDEV.code = 'EXDEV';

    vi.spyOn(fs.promises, 'rename')
      .mockRejectedValueOnce(errEXDEV)
      .mockResolvedValue(undefined);

    const spyCp = vi.spyOn(fs.promises, 'cp').mockResolvedValue(undefined);
    vi.spyOn(fs.promises, 'mkdir').mockResolvedValue(undefined);

    const result = await moveJobToTerminados('job-123', sourcePath);

    expect(result.moved).toBe(true);
    expect(spyCp).toHaveBeenCalled();
  });

  it('debería abortar fallback EXDEV si la integridad no coincide', async () => {
    const sourcePath = 'P260251 - Proyecto de Prueba';

    vi.spyOn(fs.promises, 'access').mockImplementation(async (p) => {
      if (p.includes('1ACTIVOS') && !p.includes('P260251')) return undefined;
      if (p.includes('TERMINADOS') && !p.includes('P260251') && !p.includes('.trash')) return undefined;
      if (p.includes('.trash')) return undefined;
      throw new Error('ENOENT');
    });

    vi.spyOn(fs.promises, 'readdir').mockImplementation(async (p) => {
      if (p.endsWith('1ACTIVOS')) {
        return [createDirent(sourcePath, true)];
      }
      if (p.includes('P260251') && p.includes('1ACTIVOS')) {
        return [createDirent('foto1.jpg', false), createDirent('foto2.jpg', false)];
      }
      if (p.includes('P260251') && p.includes('TERMINADOS')) {
        return [createDirent('foto1.jpg', false)];
      }
      return [];
    });

    vi.spyOn(fs.promises, 'stat').mockResolvedValue({ size: 1024 });

    const errEXDEV = new Error('Cross-device link');
    errEXDEV.code = 'EXDEV';

    vi.spyOn(fs.promises, 'rename').mockRejectedValue(errEXDEV);
    vi.spyOn(fs.promises, 'cp').mockResolvedValue(undefined);
    vi.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
    vi.spyOn(fs.promises, 'mkdir').mockResolvedValue(undefined);

    await expect(moveJobToTerminados('job-123', sourcePath))
      .rejects.toThrow(/Integridad comprometida/);
  });

  it('debería usar rename atómico cuando está en el mismo montaje (sin EXDEV)', async () => {
    vi.spyOn(fs.promises, 'access').mockImplementation(async (p) => {
      if (p.includes('1ACTIVOS')) return undefined;
      throw new Error('ENOENT');
    });

    vi.spyOn(fs.promises, 'readdir').mockResolvedValue([
      createDirent('P260251 - Proyecto', true)
    ]);

    const spyRename = vi.spyOn(fs.promises, 'rename').mockResolvedValue(undefined);
    const spyCp = vi.spyOn(fs.promises, 'cp');

    const result = await moveJobToTerminados('job-123', 'P260251 - Proyecto');

    expect(result.moved).toBe(true);
    expect(spyRename).toHaveBeenCalled();
    expect(spyCp).not.toHaveBeenCalled();
  });
});