import { describe, it, expect, vi } from 'vitest';

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

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

injectMock('../../src/utils/logger', { logger: mockLogger, asyncLocalStorage: { run: (_id, fn) => fn() } });

const requestLogger = require('../../src/middleware/request-logger');

function createMockReqRes(path, method = 'GET') {
  const listeners = {};
  const req = { path, method };
  const res = {
    statusCode: 200,
    on: vi.fn((event, handler) => {
      listeners[event] = handler;
    }),
    finished: false,
  };
  return { req, res, listeners };
}

describe('request-logger middleware', () => {
  it('debería saltar /health para no spammear logs', () => {
    const { req, res } = createMockReqRes('/health');
    const next = vi.fn();
    requestLogger(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.on).not.toHaveBeenCalled();
  });

  it('debería saltar /v1/health', () => {
    const { req, res } = createMockReqRes('/v1/health');
    const next = vi.fn();
    requestLogger(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.on).not.toHaveBeenCalled();
  });

  it('debería registrar peticiones 2xx con logger.info', () => {
    const { req, res, listeners } = createMockReqRes('/api/dashboard', 'GET');
    const next = vi.fn();
    requestLogger(req, res, next);
    expect(res.on).toHaveBeenCalledWith('finish', expect.any(Function));
    listeners.finish();
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('GET /api/dashboard 200'));
  });

  it('debería registrar peticiones 4xx con logger.warn', () => {
    const { req, res, listeners } = createMockReqRes('/api/dashboard', 'POST');
    res.statusCode = 401;
    requestLogger(req, res, vi.fn());
    listeners.finish();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('POST /api/dashboard 401'));
  });

  it('debería registrar peticiones 5xx con logger.error', () => {
    const { req, res, listeners } = createMockReqRes('/api/logs', 'GET');
    res.statusCode = 500;
    requestLogger(req, res, vi.fn());
    listeners.finish();
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('GET /api/logs 500'));
  });
});
