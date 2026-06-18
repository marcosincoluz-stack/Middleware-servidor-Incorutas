import { describe, it, expect, vi, beforeEach } from 'vitest';

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

injectMock('../../src/utils/logger', {
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
});

const { CircuitBreaker } = require('../../src/utils/circuit-breaker');

describe('CircuitBreaker', () => {
  let breaker;

  beforeEach(() => {
    breaker = new CircuitBreaker('test', {
      failureThreshold: 3,
      resetTimeoutMs: 100,
    });
  });

  it('debería empezar en estado CLOSED', () => {
    expect(breaker.getStatus().state).toBe('closed');
    expect(breaker.getStatus().isOpen).toBe(false);
  });

  it('debería ejecutar la operación cuando está CLOSED', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await breaker.execute(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalled();
  });

  it('debería contar fallos pero mantenerse CLOSED bajo el threshold', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));
    await expect(breaker.execute(fn)).rejects.toThrow('fail');
    await expect(breaker.execute(fn)).rejects.toThrow('fail');
    expect(breaker.getStatus().state).toBe('closed');
    expect(breaker.getStatus().failureCount).toBe(2);
  });

  it('debería abrir el circuito tras alcanzar el threshold de fallos', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));
    await expect(breaker.execute(fn)).rejects.toThrow('fail');
    await expect(breaker.execute(fn)).rejects.toThrow('fail');
    await expect(breaker.execute(fn)).rejects.toThrow('fail');
    expect(breaker.getStatus().state).toBe('open');
    expect(breaker.getStatus().isOpen).toBe(true);
  });

  it('debería fallar inmediatamente sin ejecutar la operación cuando está OPEN', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(fn)).rejects.toThrow('fail');
    }
    expect(breaker.getStatus().isOpen).toBe(true);

    const successFn = vi.fn().mockResolvedValue('ok');
    await expect(breaker.execute(successFn)).rejects.toThrow(/Circuit breaker "test" is OPEN/);
    expect(successFn).not.toHaveBeenCalled();
  });

  it('debería pasar a HALF_OPEN tras el resetTimeout y permitir una prueba', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(fn)).rejects.toThrow('fail');
    }
    expect(breaker.getStatus().isOpen).toBe(true);

    await new Promise(r => setTimeout(r, 150));

    const successFn = vi.fn().mockResolvedValue('ok');
    const result = await breaker.execute(successFn);
    expect(result).toBe('ok');
    expect(breaker.getStatus().state).toBe('closed');
  });

  it('debería volver a OPEN si la prueba en HALF_OPEN falla', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(fn)).rejects.toThrow('fail');
    }

    await new Promise(r => setTimeout(r, 150));

    const failFn = vi.fn().mockRejectedValue(new Error('still failing'));
    await expect(breaker.execute(failFn)).rejects.toThrow('still failing');
    expect(breaker.getStatus().state).toBe('open');
  });

  it('debería resetear el contador de fallos tras un éxito', async () => {
    const failFn = vi.fn().mockRejectedValue(new Error('fail'));
    await expect(breaker.execute(failFn)).rejects.toThrow('fail');
    expect(breaker.getStatus().failureCount).toBe(1);

    const successFn = vi.fn().mockResolvedValue('ok');
    await breaker.execute(successFn);
    expect(breaker.getStatus().failureCount).toBe(0);
    expect(breaker.getStatus().state).toBe('closed');
  });

  it('reset() debería forzar estado CLOSED', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(fn)).rejects.toThrow('fail');
    }
    expect(breaker.getStatus().isOpen).toBe(true);

    breaker.reset();
    expect(breaker.getStatus().state).toBe('closed');
    expect(breaker.getStatus().failureCount).toBe(0);
  });
});
