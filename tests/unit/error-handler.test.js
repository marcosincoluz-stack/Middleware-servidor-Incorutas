import { describe, it, expect, vi, beforeEach } from 'vitest';

const { logger } = require('../../src/utils/logger');

const errorHandler = require('../../src/middleware/error-handler');

describe('errorHandler middleware', () => {
  let loggerErrorSpy;
  let loggerWarnSpy;

  beforeEach(() => {
    vi.restoreAllMocks();
    loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    loggerWarnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  it('debería retornar 500 con mensaje genérico para errores internos sin expose', () => {
    const err = new Error('Database connection failed');
    const req = { method: 'GET', path: '/api/dashboard' };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Error interno del servidor' });
    expect(loggerErrorSpy).toHaveBeenCalled();
  });

  it('debería exponer el mensaje cuando err.expose es true y statusCode < 500', () => {
    const err = new Error('Recurso no encontrado');
    err.statusCode = 404;
    err.expose = true;

    const req = { method: 'GET', path: '/api/missing' };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Recurso no encontrado' });
    expect(loggerWarnSpy).toHaveBeenCalled();
  });

  it('debería ocultar el mensaje para errores 4xx sin expose', () => {
    const err = new Error('Token expirado');
    err.statusCode = 401;

    const req = { method: 'POST', path: '/api/test' };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Error interno del servidor' });
  });

  it('debería incluir stack trace cuando NODE_ENV es development', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';

    const err = new Error('Test error');
    const req = { method: 'GET', path: '/test' };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();

    errorHandler(err, req, res, next);

    const responseBody = res.json.mock.calls[0][0];
    expect(responseBody).toHaveProperty('stack');

    process.env.NODE_ENV = originalEnv;
  });

  it('no debería incluir stack trace cuando NODE_ENV no es development', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    const err = new Error('Test error');
    const req = { method: 'GET', path: '/test' };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();

    errorHandler(err, req, res, next);

    const responseBody = res.json.mock.calls[0][0];
    expect(responseBody).not.toHaveProperty('stack');

    process.env.NODE_ENV = originalEnv;
  });

  it('debería usar statusCode del error si está definido', () => {
    const err = new Error('Rate limit exceeded');
    err.statusCode = 429;
    err.expose = true;

    const req = { method: 'POST', path: '/api/backfill' };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith({ error: 'Rate limit exceeded' });
  });
});