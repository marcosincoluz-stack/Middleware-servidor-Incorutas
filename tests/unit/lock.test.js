import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryLockProvider, RedisLockProvider, createLockProvider } from '../../src/utils/lock';

describe('MemoryLockProvider', () => {
  let lock;

  beforeEach(() => {
    lock = new MemoryLockProvider();
  });

  it('debería adquirir y liberar un lock correctamente', async () => {
    await lock.acquire('P260251');
    expect(lock.isLocked('P260251')).toBe(true);
    lock.release('P260251');
    expect(lock.isLocked('P260251')).toBe(false);
  });

  it('debería lanzar error si se intenta adquirir un lock ya ocupado', async () => {
    await lock.acquire('P260251');
    await expect(lock.acquire('P260251')).rejects.toThrow(/Lock contention/);
    lock.release('P260251');
  });

  it('debería permitir adquirir un lock expirado', async () => {
    await lock.acquire('P260251', 1);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(lock.isLocked('P260251')).toBe(false);
    await lock.acquire('P260251');
    lock.release('P260251');
  });

  it('debería permitir locks diferentes para claves diferentes', async () => {
    await lock.acquire('P260251');
    await lock.acquire('P260252');
    expect(lock.isLocked('P260251')).toBe(true);
    expect(lock.isLocked('P260252')).toBe(true);
    lock.release('P260251');
    lock.release('P260252');
  });

  it('isLocked debería devolver false para claves sin lock', () => {
    expect(lock.isLocked('P999999')).toBe(false);
  });

  it('release en una clave sin lock no debería lanzar error', () => {
    expect(() => lock.release('P999999')).not.toThrow();
  });
});

describe('RedisLockProvider', () => {
  let mockRedis;
  let lock;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockRedis = {
      set: vi.fn(),
      eval: vi.fn(),
      exists: vi.fn(),
    };

    lock = new RedisLockProvider(mockRedis);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('debería adquirir un lock exitosamente con SET NX', async () => {
    mockRedis.set.mockResolvedValue('OK');

    await lock.acquire('P260251', 30000);

    expect(mockRedis.set).toHaveBeenCalledWith(
      'lock:P260251',
      expect.any(String),
      'PX',
      30000,
      'NX'
    );
  });

  it('debería lanzar error si el lock ya está adquirido', async () => {
    mockRedis.set.mockResolvedValue(null);

    await expect(lock.acquire('P260251')).rejects.toThrow(/Lock contention/);
  });

  it('debería liberar el lock con Lua script si el owner coincide', async () => {
    mockRedis.set.mockResolvedValue('OK');
    mockRedis.eval.mockResolvedValue(1);

    await lock.acquire('P260251');
    lock.release('P260251');

    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'lock:P260251',
      expect.any(String)
    );
  });

  it('debería reportar isLocked=true si la clave existe en Redis', async () => {
    mockRedis.exists.mockResolvedValue(1);

    const result = await lock.isLocked('P260251');

    expect(result).toBe(true);
    expect(mockRedis.exists).toHaveBeenCalledWith('lock:P260251');
  });

  it('debería reportar isLocked=false si la clave no existe en Redis', async () => {
    mockRedis.exists.mockResolvedValue(0);

    const result = await lock.isLocked('P260251');

    expect(result).toBe(false);
  });
});

describe('createLockProvider', () => {
  it('debería crear MemoryLockProvider por defecto', () => {
    const provider = createLockProvider();
    expect(provider).toBeInstanceOf(MemoryLockProvider);
  });

  it('debería crear MemoryLockProvider cuando se especifica "memory"', () => {
    const provider = createLockProvider('memory');
    expect(provider).toBeInstanceOf(MemoryLockProvider);
  });

  it('debería lanzar error para proveedor desconocido', () => {
    expect(() => createLockProvider('unknown')).toThrow(/Proveedor de lock desconocido/);
  });

  it('debería crear RedisLockProvider cuando se especifica "redis" con conexión', () => {
    const mockRedis = { set: vi.fn(), eval: vi.fn(), exists: vi.fn() };
    const provider = createLockProvider('redis', mockRedis);
    expect(provider).toBeInstanceOf(RedisLockProvider);
  });

  it('debería lanzar error si RedisLockProvider no recibe conexión Redis', () => {
    expect(() => createLockProvider('redis')).toThrow(/requiere una conexión Redis/);
  });

  it('debería lanzar error si RedisLockProvider recibe null', () => {
    expect(() => createLockProvider('redis', null)).toThrow(/requiere una conexión Redis/);
  });
});