import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

const originalReadFileSync = fs.readFileSync;
const originalExistsSync = fs.existsSync;
const originalWriteFileSync = fs.writeFileSync;
const originalRenameSync = fs.renameSync;
const originalWriteFile = fs.promises.writeFile;
const originalRename = fs.promises.rename;

const clearRequireCachePattern = (pattern) => {
  for (const key of Object.keys(require.cache)) {
    if (key.toLowerCase().includes(pattern.toLowerCase())) {
      delete require.cache[key];
    }
  }
};

describe('metrics-store service', () => {
  let metricsStore;
  let spyWriteFile, spyRename, spyWriteFileSync, spyRenameSync;
  let mockExistsValue = false;
  let mockReadValue = '{}';

  beforeEach(() => {
    vi.restoreAllMocks();
    mockExistsValue = false;
    mockReadValue = '{}';
    
    // Spies de operaciones de archivos condicionales (para evitar escribir en disco de verdad y no romper la carga de librerías)
    spyWriteFile = vi.spyOn(fs.promises, 'writeFile').mockImplementation((path, data, options) => {
      if (typeof path === 'string' && path.toLowerCase().includes('metrics.json')) {
        return Promise.resolve();
      }
      return originalWriteFile(path, data, options);
    });

    spyRename = vi.spyOn(fs.promises, 'rename').mockImplementation((oldPath, newPath) => {
      if (typeof oldPath === 'string' && oldPath.toLowerCase().includes('metrics.json')) {
        return Promise.resolve();
      }
      return originalRename(oldPath, newPath);
    });

    spyWriteFileSync = vi.spyOn(fs, 'writeFileSync').mockImplementation((path, data, options) => {
      if (typeof path === 'string' && path.toLowerCase().includes('metrics.json')) {
        return;
      }
      return originalWriteFileSync(path, data, options);
    });

    spyRenameSync = vi.spyOn(fs, 'renameSync').mockImplementation((oldPath, newPath) => {
      if (typeof oldPath === 'string' && oldPath.toLowerCase().includes('metrics.json')) {
        return;
      }
      return originalRenameSync(oldPath, newPath);
    });

    vi.spyOn(fs, 'existsSync').mockImplementation((path) => {
      if (typeof path === 'string' && path.toLowerCase().includes('metrics.json')) {
        return mockExistsValue;
      }
      return originalExistsSync(path);
    });

    vi.spyOn(fs, 'readFileSync').mockImplementation((path, options) => {
      if (typeof path === 'string' && path.toLowerCase().includes('metrics.json')) {
        return mockReadValue;
      }
      return originalReadFileSync(path, options);
    });

    // Limpiar caché y resetear módulos internos de Vitest
    clearRequireCachePattern('metrics-store');
    vi.resetModules();

    const mod = require('../../src/utils/metrics-store');
    metricsStore = mod.metricsStore;
    
    // Detener el temporizador interno para evitar fugas/ejecuciones asíncronas en segundo plano
    if (metricsStore && metricsStore.timer) {
      clearInterval(metricsStore.timer);
    }
  });

  it('debería inicializar con valores por defecto si no existe archivo de métricas', () => {
    const data = metricsStore.getMetrics();
    expect(data.historical.totalProcessed).toBe(0);
    expect(data.historical.totalErrors).toBe(0);
    expect(data.historical.totalPhotos).toBe(0);
    expect(data.session.processed).toBe(0);
  });

  it('debería incrementar el contador de trabajos procesados', () => {
    metricsStore.incrementProcessed();
    const data = metricsStore.getMetrics();
    expect(data.historical.totalProcessed).toBe(1);
    expect(data.session.processed).toBe(1);
  });

  it('debería incrementar el contador de errores', () => {
    metricsStore.incrementErrors();
    const data = metricsStore.getMetrics();
    expect(data.historical.totalErrors).toBe(1);
    expect(data.session.errors).toBe(1);
  });

  it('debería añadir el contador de fotos', () => {
    metricsStore.addPhotos(15);
    const data = metricsStore.getMetrics();
    expect(data.historical.totalPhotos).toBe(15);
    expect(data.session.photos).toBe(15);
  });

  it('debería omitir añadir fotos si el contador es negativo o cero', () => {
    metricsStore.addPhotos(-5);
    metricsStore.addPhotos(0);
    const data = metricsStore.getMetrics();
    expect(data.historical.totalPhotos).toBe(0);
  });

  it('debería guardar periódicamente las métricas de forma asíncrona', async () => {
    metricsStore.incrementProcessed();
    await metricsStore.flush();

    expect(spyWriteFile).toHaveBeenCalled();
    const writtenData = JSON.parse(spyWriteFile.mock.calls[0][1]);
    expect(writtenData.totalProcessed).toBe(1);
    expect(spyRename).toHaveBeenCalled();
  });

  it('debería guardar las métricas de forma síncrona en shutdown', () => {
    metricsStore.incrementErrors();
    spyWriteFileSync.mockClear();
    spyRenameSync.mockClear();
    metricsStore.shutdown();

    expect(spyWriteFileSync).toHaveBeenCalled();
    const writtenData = JSON.parse(spyWriteFileSync.mock.calls[0][1]);
    expect(writtenData.totalErrors).toBe(1);
    expect(spyRenameSync).toHaveBeenCalled();
  });

  it('debería cargar las métricas desde disco si el archivo existe', () => {
    mockExistsValue = true;
    mockReadValue = JSON.stringify({
      totalProcessed: 100,
      totalErrors: 5,
      totalPhotos: 2000,
      firstStartedAt: '2026-06-15T09:00:00.000Z'
    });

    // Forzar recarga recreando el singleton
    clearRequireCachePattern('metrics-store');
    vi.resetModules();
    const mod = require('../../src/utils/metrics-store');
    const store = mod.metricsStore;
    if (store && store.timer) clearInterval(store.timer);

    const data = store.getMetrics();
    expect(data.historical.totalProcessed).toBe(100);
    expect(data.historical.totalErrors).toBe(5);
    expect(data.historical.totalPhotos).toBe(2000);
    expect(data.historical.firstStartedAt).toBe('2026-06-15T09:00:00.000Z');
    
    // Las métricas de sesión deben seguir estando a cero
    expect(data.session.processed).toBe(0);
  });

  it('debería resetear a 0 si el archivo tiene valores no numéricos (NaN protection)', () => {
    mockExistsValue = true;
    mockReadValue = JSON.stringify({
      totalProcessed: 'corrupt',
      totalErrors: null,
      totalPhotos: NaN,
      firstStartedAt: 12345
    });

    clearRequireCachePattern('metrics-store');
    vi.resetModules();
    const mod = require('../../src/utils/metrics-store');
    const store = mod.metricsStore;
    if (store && store.timer) clearInterval(store.timer);

    const data = store.getMetrics();
    expect(data.historical.totalProcessed).toBe(0);
    expect(data.historical.totalErrors).toBe(0);
    expect(data.historical.totalPhotos).toBe(0);
    expect(typeof data.historical.firstStartedAt).toBe('string');
  });
});
