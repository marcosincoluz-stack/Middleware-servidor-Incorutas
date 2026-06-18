import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';

describe('config.js startup checks', () => {
  const configPath = require.resolve('../../src/config');
  const savedEnv = {};

  function saveEnv(keys) {
    keys.forEach(k => { savedEnv[k] = process.env[k]; });
  }

  function restoreEnv(keys) {
    keys.forEach(k => {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    });
  }

  function freshConfig() {
    const keys = Object.keys(require.cache).filter(k =>
      k.toLowerCase().includes('config') || k.toLowerCase().includes('dotenv')
    );
    keys.forEach(k => delete require.cache[k]);
    delete require.cache[configPath];
    return require('../../src/config');
  }

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('service_role key detection', () => {
    it('logs error when service_role key contains eyJ in production', () => {
      saveEnv(['NODE_ENV', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY']);
      process.env.NODE_ENV = 'production';
      process.env.SUPABASE_URL = 'https://realproj.supabase.co';
      process.env.SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig';

      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'statSync').mockImplementation((p) => {
        if (typeof p === 'string' && p.endsWith('.env')) return { mode: 0o100600 };
        return { mode: 0o040755, isDirectory: () => true };
      });

      freshConfig();

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('service_role')
      );

      restoreEnv(['NODE_ENV', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY']);
      vi.restoreAllMocks();
    });

    it('does not log error in development mode', () => {
      saveEnv(['NODE_ENV', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY']);
      process.env.NODE_ENV = 'development';
      process.env.SUPABASE_URL = 'https://realproj.supabase.co';
      process.env.SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig';

      freshConfig();

      const keyCalls = console.error.mock.calls.filter(
        c => typeof c[0] === 'string' && c[0].includes('service_role')
      );
      expect(keyCalls).toHaveLength(0);

      restoreEnv(['NODE_ENV', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY']);
    });
  });

  describe('REDIS_PASSWORD warning', () => {
    it('warns when REDIS_PASSWORD is empty in production', () => {
      saveEnv(['NODE_ENV', 'REDIS_PASSWORD', 'SUPABASE_URL']);
      process.env.NODE_ENV = 'production';
      process.env.SUPABASE_URL = 'https://realproj.supabase.co';
      delete process.env.REDIS_PASSWORD;

      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'statSync').mockImplementation((p) => {
        if (typeof p === 'string' && p.endsWith('.env')) return { mode: 0o100600 };
        return { mode: 0o040755, isDirectory: () => true };
      });

      freshConfig();

      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('REDIS_PASSWORD')
      );

      restoreEnv(['NODE_ENV', 'REDIS_PASSWORD', 'SUPABASE_URL']);
      vi.restoreAllMocks();
    });

    it('does not warn when REDIS_PASSWORD is set in production', () => {
      saveEnv(['NODE_ENV', 'REDIS_PASSWORD', 'SUPABASE_URL']);
      process.env.NODE_ENV = 'production';
      process.env.SUPABASE_URL = 'https://realproj.supabase.co';
      process.env.REDIS_PASSWORD = 'strongpassword';

      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'statSync').mockImplementation((p) => {
        if (typeof p === 'string' && p.endsWith('.env')) return { mode: 0o100600 };
        return { mode: 0o040755, isDirectory: () => true };
      });

      freshConfig();

      const pwdCalls = console.warn.mock.calls.filter(
        c => typeof c[0] === 'string' && c[0].includes('REDIS_PASSWORD')
      );
      expect(pwdCalls).toHaveLength(0);

      restoreEnv(['NODE_ENV', 'REDIS_PASSWORD', 'SUPABASE_URL']);
    });
  });

  describe('.env file permissions', () => {
    it('logs error when .env has group-readable permissions in production', () => {
      saveEnv(['NODE_ENV', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY']);
      process.env.NODE_ENV = 'production';
      process.env.SUPABASE_URL = 'https://realproj.supabase.co';
      process.env.SUPABASE_SERVICE_KEY = 'placeholder';

      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'statSync').mockImplementation((p) => {
        if (typeof p === 'string' && p.endsWith('.env')) return { mode: 0o100644 };
        return { mode: 0o040755, isDirectory: () => true };
      });

      freshConfig();

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('permisos')
      );

      restoreEnv(['NODE_ENV', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY']);
      vi.restoreAllMocks();
    });

    it('does not log error when .env has 600 permissions', () => {
      saveEnv(['NODE_ENV', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY']);
      process.env.NODE_ENV = 'production';
      process.env.SUPABASE_URL = 'https://realproj.supabase.co';
      process.env.SUPABASE_SERVICE_KEY = 'placeholder';

      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'statSync').mockImplementation((p) => {
        if (typeof p === 'string' && p.endsWith('.env')) return { mode: 0o100600 };
        return { mode: 0o040755, isDirectory: () => true };
      });

      freshConfig();

      const permCalls = console.error.mock.calls.filter(
        c => typeof c[0] === 'string' && c[0].includes('permisos')
      );
      expect(permCalls).toHaveLength(0);

      restoreEnv(['NODE_ENV', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY']);
    });

    it('skips check when .env file does not exist', () => {
      saveEnv(['NODE_ENV', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY']);
      process.env.NODE_ENV = 'production';
      process.env.SUPABASE_URL = 'https://realproj.supabase.co';
      process.env.SUPABASE_SERVICE_KEY = 'placeholder';

      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'statSync').mockImplementation((p) => {
        if (typeof p === 'string' && p.endsWith('.env')) throw new Error('ENOENT');
        return { mode: 0o040755, isDirectory: () => true };
      });

      freshConfig();

      const permCalls = console.error.mock.calls.filter(
        c => typeof c[0] === 'string' && c[0].includes('permisos')
      );
      expect(permCalls).toHaveLength(0);

      restoreEnv(['NODE_ENV', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY']);
    });

    it('skips check in development mode', () => {
      saveEnv(['NODE_ENV']);
      process.env.NODE_ENV = 'development';

      freshConfig();

      const permCalls = console.error.mock.calls.filter(
        c => typeof c[0] === 'string' && c[0].includes('permisos')
      );
      expect(permCalls).toHaveLength(0);

      restoreEnv(['NODE_ENV']);
    });
  });

  describe('Telegram warning', () => {
    it('sets HAS_TELEGRAM=false and warns when Telegram vars are empty', () => {
      saveEnv(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);
      process.env.TELEGRAM_BOT_TOKEN = '';
      process.env.TELEGRAM_CHAT_ID = '';

      const config = freshConfig();

      expect(config.HAS_TELEGRAM).toBe(false);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('TELEGRAM')
      );

      restoreEnv(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);
    });

    it('sets HAS_TELEGRAM=true when both Telegram vars are present', () => {
      saveEnv(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);
      process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
      process.env.TELEGRAM_CHAT_ID = 'chat-id';

      const config = freshConfig();

      expect(config.HAS_TELEGRAM).toBe(true);

      restoreEnv(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);
    });
  });
});