const Redis = require('ioredis');
const config = require('../config');
const { logger } = require('./logger');

const redisConfig = {
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
  password: config.REDIS_PASSWORD,
  maxRetriesPerRequest: null,
};

const connection = new Redis(redisConfig);

connection.on('error', (err) => {
  logger.error('❌ Error en la conexión de Redis:', err);
});

connection.on('connect', () => {
  logger.info('🔌 Conectado correctamente a Redis.');
});

/**
 * Retorna la conexión Redis compartida.
 * Usada por BullMQ y lock provider.
 * @returns {Redis}
 */
function getRedisConnection() {
  return connection;
}

module.exports = { connection, getRedisConnection };