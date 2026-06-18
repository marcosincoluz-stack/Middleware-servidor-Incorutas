import { describe, it, expect, vi } from 'vitest';

import requestId from '../../src/middleware/request-id';

describe('requestId middleware', () => {
  it('debería generar un UUID y asignarlo a req.id', () => {
    const req = {};
    const res = { setHeader: vi.fn() };
    const next = vi.fn();

    requestId(req, res, next);

    expect(req.id).toBeDefined();
    expect(typeof req.id).toBe('string');
    expect(req.id.length).toBe(36);
    expect(next).toHaveBeenCalledOnce();
  });

  it('debería setear header X-Request-Id en la respuesta', () => {
    const req = {};
    const res = { setHeader: vi.fn() };
    const next = vi.fn();

    requestId(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', req.id);
  });

  it('debería generar IDs únicos para cada request', () => {
    const req1 = {};
    const req2 = {};
    const res1 = { setHeader: vi.fn() };
    const res2 = { setHeader: vi.fn() };
    const next = vi.fn();

    requestId(req1, res1, next);
    requestId(req2, res2, next);

    expect(req1.id).not.toBe(req2.id);
  });
});