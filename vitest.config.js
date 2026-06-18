import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.js'],
    env: {
      SUPABASE_URL: 'https://placeholder.supabase.co',
      SUPABASE_SERVICE_KEY: 'placeholder-service-key',
      API_TOKEN: 'placeholder-api-token-12345678901234567890123456789012',
      TRABAJOS_BASE_PATH: './test_trabajos_placeholder'
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.js'],
      exclude: ['src/public/**']
    }
  }
});
