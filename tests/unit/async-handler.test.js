import { describe, it, expect, vi } from 'vitest';

import asyncHandler from '../../src/utils/async-handler';

describe('async-handler', () => {
  it('debería resolver exitosamente para handlers async que no lanzan error', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const req = {};
    const res = {};
    const next = vi.fn();

    const wrapped = asyncHandler(handler);
    await wrapped(req, res, next);

    expect(handler).toHaveBeenCalledWith(req, res, next);
    expect(next).not.toHaveBeenCalled();
  });

  it('debería llamar next con el error cuando el handler async falla', async () => {
    const error = new Error('Async error');
    const handler = vi.fn().mockRejectedValue(error);
    const req = {};
    const res = {};
    const next = vi.fn();

    const wrapped = asyncHandler(handler);
    await wrapped(req, res, next);

    expect(next).toHaveBeenCalledWith(error);
  });

  it('debería llamar next con el error cuando el handler lanza en una promesa', async () => {
    const error = new Error('Thrown error');
    const handler = vi.fn().mockImplementation(async () => { throw error; });
    const req = {};
    const res = {};
    const next = vi.fn();

    const wrapped = asyncHandler(handler);
    await wrapped(req, res, next);

    expect(next).toHaveBeenCalledWith(error);
  });
});