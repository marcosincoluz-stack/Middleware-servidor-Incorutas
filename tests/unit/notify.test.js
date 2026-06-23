import { describe, it, expect, vi, beforeEach } from 'vitest';

const TELEGRAM_BOT_TOKEN = 'test-bot-token-12345';
const TELEGRAM_CHAT_ID = 'test-chat-id-67890';

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

injectMock('../../src/config', {
  HAS_TELEGRAM: true,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  TELEGRAM_TIMEOUT_MS: 5000,
  MIN_DISK_MB: 500,
  TRABAJOS_BASE_PATH: '/mnt/smb',
});

injectMock('../../src/utils/logger', {
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
});

const mockRequestOn = vi.fn();
const mockRequestWrite = vi.fn();
const mockRequestEnd = vi.fn();
const mockRequestDestroy = vi.fn();

const mockRequest = {
  on: mockRequestOn,
  write: mockRequestWrite,
  end: mockRequestEnd,
  destroy: mockRequestDestroy,
};

const mockHttpsRequest = vi.fn().mockReturnValue(mockRequest);

injectMock('https', {
  request: mockHttpsRequest,
});

const clearCache = (pattern) => {
  for (const key of Object.keys(require.cache)) {
    if (key.toLowerCase().includes(pattern.toLowerCase())) {
      delete require.cache[key];
    }
  }
};

clearCache('notify');

const notify = require('../../src/utils/notify');

describe('notify module (con Telegram configurado)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequestOn.mockReset();
    mockRequestWrite.mockReset();
    mockRequestEnd.mockReset();
    mockRequestDestroy.mockReset();
    mockHttpsRequest.mockClear();
  });

  function simulateResponse(statusCode, _body) {
    mockHttpsRequest.mockImplementation((options, callback) => {
      const res = {
        statusCode,
        on: vi.fn((event, handler) => {
          if (event === 'data') {
            return res;
          }
          if (event === 'end') {
            setTimeout(() => handler(), 0);
          }
          return res;
        }),
      };

      const onHandlers = {};
      mockRequestOn.mockImplementation((event, handler) => {
        onHandlers[event] = handler;
        return mockRequest;
      });

      mockRequestWrite.mockImplementation(() => mockRequest);
      mockRequestEnd.mockImplementation(() => {
        if (callback) {
          callback(res);
        }
        const endHandler = res.on.mock.calls.find(call => call[0] === 'end');
        if (endHandler) {
          setTimeout(() => endHandler[1](), 0);
        }
      });

      return mockRequest;
    });
  }

  it('send() debería configurar la petición HTTPS con token y chatId correctos', async () => {
    simulateResponse(200, '{"ok":true}');

    const promise = notify.send('Test message');
    await promise;

    expect(mockHttpsRequest).toHaveBeenCalled();
    const options = mockHttpsRequest.mock.calls[0][0];
    expect(options.hostname).toBe('api.telegram.org');
    expect(options.path).toContain(TELEGRAM_BOT_TOKEN);
    expect(options.method).toBe('POST');
    expect(options.headers['Content-Type']).toBe('application/json');
  });

  it('send() debería enviar el payload como JSON con chat_id y text', async () => {
    simulateResponse(200, '{"ok":true}');

    await notify.send('Hello World');

    expect(mockRequestWrite).toHaveBeenCalled();
    const payload = JSON.parse(mockRequestWrite.mock.calls[0][0]);
    expect(payload.chat_id).toBe(TELEGRAM_CHAT_ID);
    expect(payload.text).toBe('Hello World');
    expect(payload.parse_mode).toBe('HTML');
  });

  it('send() debería devolver true cuando Telegram responde 200', async () => {
    simulateResponse(200, '{"ok":true}');

    const result = await notify.send('Test message');

    expect(result).toBe(true);
  });

  it('send() debería devolver false cuando Telegram responde con error HTTP', async () => {
    simulateResponse(403, '{"ok":false,"description":"Forbidden"}');

    const result = await notify.send('Test message');

    expect(result).toBe(false);
  });

  it('send() debería devolver false cuando hay error de red', async () => {
    mockHttpsRequest.mockImplementation((_options, _callback) => {
      const onHandlers = {};
      mockRequestOn.mockImplementation((event, handler) => {
        onHandlers[event] = handler;
        return mockRequest;
      });
      mockRequestWrite.mockImplementation(() => mockRequest);
      mockRequestEnd.mockImplementation(() => {
        setTimeout(() => {
          if (onHandlers['error']) onHandlers['error'](new Error('ECONNREFUSED'));
        }, 0);
      });
      return mockRequest;
    });

    const result = await notify.send('Test message');

    expect(result).toBe(false);
  });

  it('send() debería devolver false cuando hay timeout', async () => {
    mockHttpsRequest.mockImplementation((_options, _callback) => {
      const onHandlers = {};
      mockRequestOn.mockImplementation((event, handler) => {
        onHandlers[event] = handler;
        return mockRequest;
      });
      mockRequestWrite.mockImplementation(() => mockRequest);
      mockRequestEnd.mockImplementation(() => {
        setTimeout(() => {
          if (onHandlers['timeout']) onHandlers['timeout']();
        }, 0);
      });
      return mockRequest;
    });

    const result = await notify.send('Test message');

    expect(result).toBe(false);
  });

  it('alertLowDisk debería incluir "ESPACIO EN DISCO" en el mensaje', async () => {
    simulateResponse(200, '{"ok":true}');

    await notify.alertLowDisk(100, 500);

    expect(mockRequestWrite).toHaveBeenCalled();
    const payload = JSON.parse(mockRequestWrite.mock.calls[0][0]);
    expect(payload.text).toContain('DISCO CRÍTICO');
    expect(payload.text).toContain('100');
  });

  it('alertSmbDisconnected debería incluir "SMB" y la ruta en el mensaje', async () => {
    simulateResponse(200, '{"ok":true}');

    await notify.alertSmbDisconnected('/mnt/smb');

    expect(mockRequestWrite).toHaveBeenCalled();
    const payload = JSON.parse(mockRequestWrite.mock.calls[0][0]);
    expect(payload.text).toContain('SMB');
    expect(payload.text).toContain('/mnt/smb');
  });

  it('alertJobFailed debería incluir jobId y título en el mensaje', async () => {
    simulateResponse(200, '{"ok":true}');

    await notify.alertJobFailed('job-123', 'P260251 - Test', 'Error crítico');

    expect(mockRequestWrite).toHaveBeenCalled();
    const payload = JSON.parse(mockRequestWrite.mock.calls[0][0]);
    expect(payload.text).toContain('job-123');
    expect(payload.text).toContain('P260251 - Test');
    expect(payload.text).toContain('Error crítico');
  });

  it('alertJobFailed debería truncar errorMsg mayor a 1000 caracteres', async () => {
    simulateResponse(200, '{"ok":true}');

    const longError = 'X'.repeat(2000);
    await notify.alertJobFailed('job-123', 'Test', longError);

    const payload = JSON.parse(mockRequestWrite.mock.calls[0][0]);
    expect(payload.text).toContain('...(truncado)');
    expect(payload.text.length).toBeLessThan(2000);
  });

  it('send() debería truncar mensaje mayor a 4000 caracteres', async () => {
    simulateResponse(200, '{"ok":true}');

    const longMessage = 'A'.repeat(5000);
    await notify.send(longMessage);

    const payload = JSON.parse(mockRequestWrite.mock.calls[0][0]);
    expect(payload.text).toContain('...(truncado)');
    expect(payload.text.length).toBeLessThan(5000);
    expect(payload.text.length).toBeLessThanOrEqual(4000);
  });

  it('alertJobFailed debería escapar HTML en errorMsg para prevenir inyección', async () => {
    simulateResponse(200, '{"ok":true}');

    await notify.alertJobFailed('job-123', 'P260251 - Test', '<script>alert(1)</script>');

    const payload = JSON.parse(mockRequestWrite.mock.calls[0][0]);
    expect(payload.text).toContain('&lt;script&gt;');
    expect(payload.text).not.toContain('<script>');
  });

  it('alertJobFailed debería escapar HTML en jobId y title', async () => {
    simulateResponse(200, '{"ok":true}');

    await notify.alertJobFailed('<b>evil</b>', '<img src=x>', 'Error normal');

    const payload = JSON.parse(mockRequestWrite.mock.calls[0][0]);
    expect(payload.text).toContain('&lt;b&gt;evil&lt;/b&gt;');
    expect(payload.text).toContain('&lt;img src=x&gt;');
    expect(payload.text).not.toContain('<b>evil</b>');
  });

  it('alertPollingFailure debería incluir ciclo, fallos y error en mensaje', async () => {
    simulateResponse(200, '{"ok":true}');

    await notify.alertPollingFailure(5, 'Connection refused', 'approved');

    expect(mockRequestWrite).toHaveBeenCalled();
    const payload = JSON.parse(mockRequestWrite.mock.calls[0][0]);
    expect(payload.text).toContain('POLLING FALLIDO');
    expect(payload.text).toContain('approved');
    expect(payload.text).toContain('5');
    expect(payload.text).toContain('Connection refused');
  });

  it('alertPollingFailure debería escapar HTML en error', async () => {
    simulateResponse(200, '{"ok":true}');

    await notify.alertPollingFailure(3, '<script>x</script>', 'paid');

    const payload = JSON.parse(mockRequestWrite.mock.calls[0][0]);
    expect(payload.text).toContain('&lt;script&gt;');
    expect(payload.text).not.toContain('<script>');
  });

  it('alertPollingFailure debería truncar error mayor a 1000 caracteres', async () => {
    simulateResponse(200, '{"ok":true}');

    const longError = 'X'.repeat(2000);
    await notify.alertPollingFailure(3, longError, 'approved');

    const payload = JSON.parse(mockRequestWrite.mock.calls[0][0]);
    expect(payload.text).toContain('...(truncado)');
    expect(payload.text.length).toBeLessThan(2000);
  });
});