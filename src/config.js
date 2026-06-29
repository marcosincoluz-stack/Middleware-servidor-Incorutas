const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Cargar variables de entorno desde .env
require('dotenv').config();

const isDev = process.env.NODE_ENV === 'development';

if (!isDev && process.env.SUPABASE_URL && !process.env.SUPABASE_URL.includes('placeholder')) {
  if (process.env.SUPABASE_SERVICE_KEY && process.env.SUPABASE_SERVICE_KEY.includes('eyJ')) {
    console.error('❌ SEGURIDAD: Se detectó una service_role key real en variables de entorno.');
    console.error('   La key NO se expone vía config.js. Asegúrate de que .env tenga permisos 600 y nunca se comparta.');
  }
  if (!process.env.REDIS_PASSWORD) {
    console.warn('⚠️ ADVERTENCIA: REDIS_PASSWORD no está configurado. Se recomienda proteger Redis con contraseña en producción.');
  }
}

// Si no hay token configurado y estamos en desarrollo, generamos uno temporal
if (isDev && !process.env.API_TOKEN) {
  process.env.API_TOKEN = crypto.randomBytes(32).toString('hex');
  console.log(`🔑 [CONFIG] API_TOKEN no configurado en .env. Se ha autogenerado temporalmente:`);
  console.log(`   👉 ${process.env.API_TOKEN}`);
  console.log(`   (Guárdalo o agrégalo a tu .env para que persista)`);
}

const requiredEnv = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'TRABAJOS_BASE_PATH',
  'API_TOKEN'
];

// Comprobar variables obligatorias
const missing = requiredEnv.filter(key => !process.env[key]);
if (missing.length > 0) {
  console.error('========================================================================');
  console.error('❌ ERROR CRÍTICO DE CONFIGURACIÓN');
  console.error(`Faltan las siguientes variables de entorno obligatorias:`);
  missing.forEach(key => console.error(`  - ${key}`));
  console.error('El servidor no puede arrancar sin estas variables.');
  console.error('========================================================================');
  process.exit(1);
}

// Comprobación de Telegram
const hasTelegram = !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
if (!hasTelegram) {
  console.warn('⚠️ ADVERTENCIA: TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID no están configurados.');
  console.warn('Las notificaciones de error por Telegram estarán DESACTIVADAS.');
}

const config = {
  // Servidor
  PORT: parseInt(process.env.PORT, 10) || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  IS_DEV_MODE: process.env.NODE_ENV === 'development',

  // Supabase
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_BUCKET: process.env.SUPABASE_BUCKET || 'evidence',

  // Seguridad
  API_TOKEN: process.env.API_TOKEN,

  // Almacenamiento
  TRABAJOS_BASE_PATH: path.resolve(process.env.TRABAJOS_BASE_PATH),
  MIN_DISK_MB: parseInt(process.env.MIN_DISK_MB, 10) || 500, // 500 MB por defecto

  // Redis y Cola (BullMQ)
  REDIS_HOST: process.env.REDIS_HOST || '127.0.0.1',
  REDIS_PORT: parseInt(process.env.REDIS_PORT, 10) || 6379,
  REDIS_PASSWORD: process.env.REDIS_PASSWORD || null,
  JOB_MAX_RETRIES: parseInt(process.env.JOB_MAX_RETRIES, 10) || 3,
  JOB_BACKOFF_BASE_MS: parseInt(process.env.JOB_BACKOFF_BASE_MS, 10) || 2000,

  // Operaciones
  ENABLE_FOLDER_MOVE: process.env.ENABLE_FOLDER_MOVE === 'true',
  LOCK_PROVIDER: process.env.LOCK_PROVIDER || 'memory',

  // Telegram
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || null,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || null,
  HAS_TELEGRAM: hasTelegram,

  // Logging
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',

  // Constantes internas del sistema
  DOWNLOAD_MAX_RETRIES: 3,
  DOWNLOAD_RETRY_DELAY_MS: 1500,
  QUEUE_CONCURRENCY: 1,
  STALLED_INTERVAL_MS: parseInt(process.env.STALLED_INTERVAL_MS, 10) || 30000,
  LOCK_DURATION_MS: parseInt(process.env.LOCK_DURATION_MS, 10) || 60000,
  LIMITER_MAX: 1,
  LIMITER_DURATION_MS: 1000,
  REMOVE_ON_MAX: 100,
  RECENT_JOBS_MAX: 5,
  TELEGRAM_TIMEOUT_MS: 8000,
  MAX_FILE_SIZE_MB: parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 50,
  MAX_EVIDENCES_PER_JOB: parseInt(process.env.MAX_EVIDENCES_PER_JOB, 10) || 150,
  MAX_COLLISIONS: parseInt(process.env.MAX_COLLISIONS, 10) || 100,
  DISK_CHECK_INTERVAL: parseInt(process.env.DISK_CHECK_INTERVAL, 10) || 10,
  PART_CLEANUP_ON_STARTUP: process.env.PART_CLEANUP_ON_STARTUP !== 'false',
  BACKFILL_MAX_JOBS: parseInt(process.env.BACKFILL_MAX_JOBS, 10) || 100,
  BACKFILL_MAX_PENDING: parseInt(process.env.BACKFILL_MAX_PENDING, 10) || 200,
  DASHBOARD_CACHE_TTL_MS: 5000,
  SECONDARY_CACHE_TTL_MS: parseInt(process.env.SECONDARY_CACHE_TTL_MS, 10) || 5000,

  // Tolerancia a fallos de descarga
  DOWNLOAD_TOLERANCE_PERCENT: parseInt(process.env.DOWNLOAD_TOLERANCE_PERCENT, 10) || 0,

  // Polling
  POLLING_INTERVAL_MS: parseInt(process.env.POLLING_INTERVAL_MS, 10) || 30000,
  POLLING_ENABLED: process.env.POLLING_ENABLED !== 'false',
  POLLING_FAILURE_ALERT_THRESHOLD: parseInt(process.env.POLLING_FAILURE_ALERT_THRESHOLD, 10) || 3,
  POLLING_ALERT_COOLDOWN_MS: parseInt(process.env.POLLING_ALERT_COOLDOWN_MS, 10) || 300000,

  // Lectura de logs (dashboard)
  LOG_TAIL_MAX_BYTES: parseInt(process.env.LOG_TAIL_MAX_BYTES, 10) || 65536,

  // Circuit Breaker
  CIRCUIT_BREAKER_THRESHOLD: parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD, 10) || 5,
  CIRCUIT_BREAKER_RESET_MS: parseInt(process.env.CIRCUIT_BREAKER_RESET_MS, 10) || 30000,

  // Health Check
  HEALTH_PING_TIMEOUT_MS: parseInt(process.env.HEALTH_PING_TIMEOUT_MS, 10) || 3000,

  // Lista blanca de extensiones de imagen permitidas para descarga
  ALLOWED_IMAGE_EXTENSIONS: (process.env.ALLOWED_IMAGE_EXTENSIONS || 'jpg,jpeg,png,webp,heic,heif,gif,bmp,tiff,tif')
    .split(',')
    .map(ext => `.${ext.trim().toLowerCase()}`)
    .filter(ext => ext.length > 1),
};

// Verificar permisos del archivo .env en producción
if (!isDev) {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    const envStat = fs.statSync(envPath);
    const mode = envStat.mode & 0o777;
    if (mode & 0o044) {
      console.error(`❌ SEGURIDAD: .env tiene permisos excesivamente abiertos (0${(mode & 0o777).toString(8).padStart(3, '0')}).`);
      console.error('   Ejecuta: chmod 600 .env');
    }
  } catch {
    // .env no encontrado — está bien si usas EnvironmentFile o vars del sistema
  }
}

// Verificar si la ruta base existe al arrancar
try {
  if (!fs.existsSync(config.TRABAJOS_BASE_PATH)) {
    console.warn(`⚠️ ADVERTENCIA: La ruta base TRABAJOS_BASE_PATH no existe: ${config.TRABAJOS_BASE_PATH}`);
    console.warn('Asegúrate de que el volumen de red esté montado antes de procesar descargas.');
  } else {
    const stat = fs.statSync(config.TRABAJOS_BASE_PATH);
    if (!stat.isDirectory()) {
      console.error(`❌ ERROR: TRABAJOS_BASE_PATH existe pero no es un directorio: ${config.TRABAJOS_BASE_PATH}`);
      process.exit(1);
    }
  }
} catch (err) {
  console.warn(`⚠️ ADVERTENCIA: Error al comprobar TRABAJOS_BASE_PATH: ${err.message}`);
}

module.exports = config;
