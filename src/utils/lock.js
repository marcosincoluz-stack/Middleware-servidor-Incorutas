const { logger } = require('./logger');
const crypto = require('crypto');

const LOCK_PREFIX = 'lock:';

class MemoryLockProvider {
  constructor() {
    this._locks = new Map();
  }

  /**
   * Adquiere un lock sobre la clave especificada.
   * @param {string} key Clave identificadora del recurso a bloquear
   * @param {number} [ttlMs=30000] Tiempo de vida del lock en milisegundos
   * @returns {Promise<void>}
   * @throws {Error} Si el recurso ya está bloqueado
   */
  async acquire(key, ttlMs = 30000) {
    const now = Date.now();
    const existing = this._locks.get(key);

    if (existing && existing.expiresAt > now) {
      throw new Error(`Lock contention: el recurso "${key}" ya está bloqueado hasta ${new Date(existing.expiresAt).toISOString()}. Intenta de nuevo más tarde.`);
    }

    this._locks.set(key, { expiresAt: now + ttlMs });
    logger.debug(`Lock adquirido para "${key}" (TTL: ${ttlMs}ms)`);
  }

  /**
   * Libera el lock sobre la clave especificada.
   * @param {string} key Clave identificadora del recurso a liberar
   * @returns {Promise<void>}
   */
  async release(key) {
    const deleted = this._locks.delete(key);
    if (deleted) {
      logger.debug(`Lock liberado para "${key}"`);
    }
  }

  /**
   * Comprueba si un recurso está bloqueado.
   * @param {string} key Clave identificadora del recurso
   * @returns {boolean} true si el recurso está bloqueado, false si no
   */
  isLocked(key) {
    const existing = this._locks.get(key);
    if (!existing) return false;
    if (existing.expiresAt <= Date.now()) {
      this._locks.delete(key);
      return false;
    }
    return true;
  }
}

class RedisLockProvider {
  /**
   * @param {import('ioredis').Redis} redis Conexión Redis compartida
   */
  constructor(redis) {
    this._redis = redis;
  }

  /**
   * Adquiere un lock distribuido sobre Redis usando SET NX PX.
   * @param {string} key Clave identificadora del recurso a bloquear
   * @param {number} [ttlMs=30000] Tiempo de vida del lock en milisegundos
   * @returns {Promise<void>}
   * @throws {Error} Si el recurso ya está bloqueado o Redis no está disponible
   */
  async acquire(key, ttlMs = 30000) {
    const redisKey = `${LOCK_PREFIX}${key}`;
    const ownerId = crypto.randomUUID();

    const result = await this._redis.set(redisKey, ownerId, 'PX', ttlMs, 'NX');

    if (result === 'OK') {
      this._ownerId = ownerId;
      this._lockedKey = key;
      logger.debug(`Lock Redis adquirido para "${key}" (TTL: ${ttlMs}ms, owner: ${ownerId})`);
    } else {
      throw new Error(`Lock contention: el recurso "${key}" ya está bloqueado en Redis. Intenta de nuevo más tarde.`);
    }
  }

  /**
   * Libera el lock solo si el owner coincide (Lua script seguro).
   * @param {string} key Clave identificadora del recurso a liberar
   * @returns {Promise<void>}
   */
  async release(key) {
    if (!this._ownerId) return;

    const redisKey = `${LOCK_PREFIX}${key}`;
    const script = `
      if redis.call('get', KEYS[1]) == ARGV[1] then
        return redis.call('del', KEYS[1])
      else
        return 0
      end
    `;

    try {
      const result = await this._redis.eval(script, 1, redisKey, this._ownerId);
      if (result === 1) {
        logger.debug(`Lock Redis liberado para "${key}"`);
      } else {
        logger.debug(`Lock Redis no liberado para "${key}" (owner no coincide o expiró)`);
      }
    } catch (err) {
      logger.debug(`Error liberando lock Redis para "${key}": ${err.message}`);
    }
  }

  /**
   * Comprueba si un recurso está bloqueado en Redis.
   * @param {string} key Clave identificadora del recurso
   * @returns {Promise<boolean>} true si está bloqueado, false si no
   */
  async isLocked(key) {
    const redisKey = `${LOCK_PREFIX}${key}`;
    const exists = await this._redis.exists(redisKey);
    return exists === 1;
  }
}

/**
 * Crea una instancia de proveedor de locks según el tipo especificado.
 * @param {'memory'|'redis'} [providerType='memory'] Tipo de proveedor de lock
 * @param {import('ioredis').Redis} [redis] Conexión Redis (requerida si providerType='redis')
 * @returns {MemoryLockProvider|RedisLockProvider}
 * @throws {Error} Si el tipo de proveedor no es válido o falta Redis
 */
function createLockProvider(providerType = 'memory', redis = null) {
  switch (providerType) {
    case 'memory':
      return new MemoryLockProvider();
    case 'redis':
      if (!redis) {
        throw new Error('RedisLockProvider requiere una conexión Redis. Pasa una instancia de ioredis.');
      }
      return new RedisLockProvider(redis);
    default:
      throw new Error(`Proveedor de lock desconocido: "${providerType}". Usa "memory" o "redis".`);
  }
}

module.exports = { createLockProvider, MemoryLockProvider, RedisLockProvider };