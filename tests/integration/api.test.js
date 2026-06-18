import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import http from 'http';

const TEST_PORT = 3999;

process.env.PORT = TEST_PORT.toString();
process.env.NODE_ENV = 'production';
process.env.API_TOKEN = 'test-api-token-12345678901234567890123456789012';
process.env.TRABAJOS_BASE_PATH = path.resolve(__dirname, '../../scratch_test_integration');
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.TELEGRAM_CHAT_ID = '';
process.env.POLLING_ENABLED = 'false';

const mockQueue = {
  enqueue: vi.fn().mockResolvedValue(undefined),
  getPendingCount: vi.fn().mockResolvedValue(0),
  getStatus: vi.fn().mockResolvedValue({
    pendingCount: 0,
    isProcessing: false,
    totalProcessed: 0,
    totalErrors: 0,
    totalPhotos: 0,
    lastJobProcessed: null,
    lastProcessedAt: null,
    currentJob: null,
    currentJobStartedAt: null,
    startedAt: new Date().toISOString(),
    recentJobs: []
  }),
  addPhotosCount: vi.fn(),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getFailedJobs: vi.fn().mockResolvedValue([]),
};

require.cache[require.resolve('../../src/jobs/bull-queue')] = {
  id: require.resolve('../../src/jobs/bull-queue'),
  filename: require.resolve('../../src/jobs/bull-queue'),
  loaded: true,
  exports: { jobQueue: mockQueue }
};

const { server } = require('../../src/index');

function makeRequest(method, urlPath, headers = {}, body = null, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const reqHeaders = { ...headers };
    if (payload) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: urlPath,
      method: method,
      headers: reqHeaders,
      timeout: timeoutMs
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch {
          json = data;
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: json
        });
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });
    req.on('error', (err) => reject(err));
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

describe('Integration Tests (API Endpoints)', () => {
  beforeAll(async () => {
    if (!fs.existsSync(process.env.TRABAJOS_BASE_PATH)) {
      fs.mkdirSync(process.env.TRABAJOS_BASE_PATH, { recursive: true });
    }
    await new Promise(r => setTimeout(r, 500));
  });

  afterAll(async () => {
    await new Promise((resolve) => {
      server.close(() => {
        try {
          if (fs.existsSync(process.env.TRABAJOS_BASE_PATH)) {
            fs.rmSync(process.env.TRABAJOS_BASE_PATH, { recursive: true, force: true });
          }
        } catch (err) {
          console.warn('No se pudo borrar el directorio temporal:', err.message);
        }
        resolve();
      });
    });
  });

  it('GET /health responde con estructura correcta (200 o 500 si dependencias caídas)', async () => {
    const res = await makeRequest('GET', '/health', {}, null, 15000);
    expect([200, 500]).toContain(res.statusCode);
    expect(res.body.version).toBe(require('../../package.json').version);
    expect(res.body).toHaveProperty('status');
    expect(res.body).toHaveProperty('uptime');
    expect(res.body).toHaveProperty('redis');
    expect(res.body).toHaveProperty('supabase');
  }, 20000);

  it('GET /api/dashboard sin token responde 401', async () => {
    const res = await makeRequest('GET', '/api/dashboard');
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Falta token de autenticación (Authorization header requerido)');
  });

  it('GET /api/dashboard con token inválido responde 401', async () => {
    const headers = { 'Authorization': 'Bearer token-incorrecto' };
    const res = await makeRequest('GET', '/api/dashboard', headers);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Token de autenticación inválido');
  });

  it('GET /api/dashboard con token correcto responde 200', async () => {
    const headers = { 'Authorization': `Bearer ${process.env.API_TOKEN}` };
    const res = await makeRequest('GET', '/api/dashboard', headers);
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('health');
    expect(res.body).toHaveProperty('queue');
  });

  it('GET /metrics sin token responde 401', async () => {
    const res = await makeRequest('GET', '/metrics');
    expect(res.statusCode).toBe(401);
  });

  it('GET /metrics con token responde con formato Prometheus', async () => {
    const headers = { 'Authorization': `Bearer ${process.env.API_TOKEN}` };
    const res = await makeRequest('GET', '/metrics', headers);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('photo_sync_jobs_total');
    expect(res.body).toContain('photo_sync_session_jobs_total');
    expect(res.body).toContain('photo_sync_photos_total');
    expect(res.body).toContain('photo_sync_process_uptime_seconds');
  });

  it('POST /api/retry-failed/:jobId sin token responde 401', async () => {
    const res = await makeRequest('POST', '/api/retry-failed/some-job-id');
    expect(res.statusCode).toBe(401);
  });

  it('POST /api/retry-failed/:jobId con token y jobId vacio responde 400', async () => {
    const headers = { 'Authorization': `Bearer ${process.env.API_TOKEN}` };
    const res = await makeRequest('POST', '/api/retry-failed/', headers);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('GET /api/failed-evidences sin token responde 401', async () => {
    const res = await makeRequest('GET', '/api/failed-evidences');
    expect(res.statusCode).toBe(401);
  });

  it('GET /api/failed-evidences con token responde (auth OK, Supabase may fail)', async () => {
    const headers = { 'Authorization': `Bearer ${process.env.API_TOKEN}` };
    const res = await makeRequest('GET', '/api/failed-evidences', headers, null, 10000);
    expect([200, 500]).toContain(res.statusCode);
  }, 15000);
});
