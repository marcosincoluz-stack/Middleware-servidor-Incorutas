process.env.API_TOKEN = 'test-secret-api-token-1234567890123456';
process.env.NODE_ENV = 'production';

import { describe, it, expect, vi, beforeEach } from 'vitest';

const clearCache = (pattern) => {
  for (const key of Object.keys(require.cache)) {
    if (key.toLowerCase().includes(pattern.toLowerCase())) {
      delete require.cache[key];
    }
  }
};

clearCache('api-auth');
clearCache('config');
vi.resetModules();

const { verifyApiToken } = require('../../src/middleware/api-auth');

function createMockRes() {
  const res = {
    statusCode: 200,
    _json: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(data) {
      res._json = data;
      return res;
    },
  };
  return res;
}

describe('api-auth middleware', () => {
  let mockNext;

  beforeEach(() => {
    mockNext = vi.fn();
  });

  it('retorna 401 si falta la cabecera Authorization', () => {
    const req = { headers: {}, ip: '127.0.0.1', path: '/api/dashboard' };
    const res = createMockRes();

    verifyApiToken(req, res, mockNext);

    expect(res.statusCode).toBe(401);
    expect(res._json.error).toContain('Falta token');
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('retorna 401 si el formato de Authorization no es Bearer', () => {
    const req = {
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
      ip: '127.0.0.1',
      path: '/api/dashboard',
    };
    const res = createMockRes();

    verifyApiToken(req, res, mockNext);

    expect(res.statusCode).toBe(401);
    expect(res._json.error).toContain('Formato de autenticación inválido');
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('retorna 401 si el token es incorrecto', () => {
    const req = {
      headers: { authorization: 'Bearer wrong-token-that-is-wrong-length!!' },
      ip: '127.0.0.1',
      path: '/api/backfill',
    };
    const res = createMockRes();

    verifyApiToken(req, res, mockNext);

    expect(res.statusCode).toBe(401);
    expect(res._json.error).toContain('Token de autenticación inválido');
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('llama a next() si el token es correcto', () => {
    const req = {
      headers: { authorization: `Bearer ${process.env.API_TOKEN}` },
      ip: '127.0.0.1',
      path: '/api/config',
    };
    const res = createMockRes();

    verifyApiToken(req, res, mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('retorna 401 si el token tiene longitud diferente al configurado', () => {
    const req = {
      headers: { authorization: 'Bearer short' },
      ip: '127.0.0.1',
      path: '/api/logs',
    };
    const res = createMockRes();

    verifyApiToken(req, res, mockNext);

    expect(res.statusCode).toBe(401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('retorna 500 si API_TOKEN no está configurado en producción', () => {
    const config = require('../../src/config');
    const originalToken = config.API_TOKEN;
    config.API_TOKEN = null;

    const req = {
      headers: { authorization: 'Bearer some-token' },
      ip: '127.0.0.1',
      path: '/api/dashboard',
    };
    const res = createMockRes();

    verifyApiToken(req, res, mockNext);

    expect(res.statusCode).toBe(500);
    expect(res._json.error).toContain('Error interno de configuración');
    expect(mockNext).not.toHaveBeenCalled();

    config.API_TOKEN = originalToken;
  });
});
