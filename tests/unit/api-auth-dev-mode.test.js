import { describe, it, expect, vi } from 'vitest';

import { verifyApiToken } from '../../src/middleware/api-auth';

describe('api-auth middleware - dev mode bypass', () => {
  it('debería rechazar peticiones sin Authorization header en producción', () => {
    const config = require('../../src/config');
    const originalDevMode = config.IS_DEV_MODE;

    const req = { headers: {}, ip: '127.0.0.1', path: '/api/test' };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    };
    const next = vi.fn();

    if (!originalDevMode) {
      verifyApiToken(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    }

    config.IS_DEV_MODE = originalDevMode;
  });
});