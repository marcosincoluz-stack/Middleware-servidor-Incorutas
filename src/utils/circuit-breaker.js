const { logger } = require('./logger');

const STATES = {
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half_open',
};

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_RESET_TIMEOUT_MS = 30000;

/**
 * Circuit Breaker genérico para proteger operaciones async contra fallos en cascada.
 *
 * Estados:
 * - CLOSED: operación normal. Si se acumulan `failureThreshold` fallos consecutivos, pasa a OPEN.
 * - OPEN: toda llamada falla inmediatamente sin ejecutar la operación. Tras `resetTimeoutMs`, pasa a HALF_OPEN.
 * - HALF_OPEN: se permite una llamada de prueba. Si éxito → CLOSED. Si fallo → OPEN.
 */
class CircuitBreaker {
  /**
   * @param {string} name Nombre identificativo (ej: 'redis', 'supabase')
   * @param {{ failureThreshold?: number, resetTimeoutMs?: number }} [options]
   */
  constructor(name, options = {}) {
    this.name = name;
    this.failureThreshold = options.failureThreshold || DEFAULT_FAILURE_THRESHOLD;
    this.resetTimeoutMs = options.resetTimeoutMs || DEFAULT_RESET_TIMEOUT_MS;
    this.state = STATES.CLOSED;
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.nextAttemptTime = null;
  }

  /**
   * Ejecuta una operación async a través del circuit breaker.
   *
   * @param {() => Promise<any>} fn Operación a ejecutar
   * @returns {Promise<any>} Resultado de la operación
   * @throws {Error} Si el circuito está abierto: "Circuit breaker [name] is OPEN"
   */
  async execute(fn) {
    if (this.state === STATES.OPEN) {
      if (Date.now() < this.nextAttemptTime) {
        throw new Error(`Circuit breaker "${this.name}" is OPEN — reintentando en ${Math.ceil((this.nextAttemptTime - Date.now()) / 1000)}s`);
      }
      this.state = STATES.HALF_OPEN;
      logger.info(`[CircuitBreaker] "${this.name}" pasando a HALF_OPEN — permitiendo prueba`);
    }

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure();
      throw err;
    }
  }

  _onSuccess() {
    if (this.state === STATES.HALF_OPEN) {
      logger.info(`[CircuitBreaker] "${this.name}" recuperado — pasando a CLOSED`);
    }
    this.failureCount = 0;
    this.state = STATES.CLOSED;
    this.nextAttemptTime = null;
  }

  _onFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === STATES.HALF_OPEN) {
      this.state = STATES.OPEN;
      this.nextAttemptTime = Date.now() + this.resetTimeoutMs;
      logger.warn(`[CircuitBreaker] "${this.name}" prueba fallida en HALF_OPEN — volviendo a OPEN por ${this.resetTimeoutMs}ms`);
      return;
    }

    if (this.failureCount >= this.failureThreshold) {
      this.state = STATES.OPEN;
      this.nextAttemptTime = Date.now() + this.resetTimeoutMs;
      logger.error(`[CircuitBreaker] "${this.name}" OPEN tras ${this.failureCount} fallos consecutivos — bloqueando por ${this.resetTimeoutMs}ms`);
    }
  }

  /**
   * Retorna el estado actual del circuit breaker.
   * @returns {{ state: string, failureCount: number, isOpen: boolean }}
   */
  getStatus() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      isOpen: this.state === STATES.OPEN,
    };
  }

  /**
   * Resetea el circuit breaker a estado CLOSED.
   */
  reset() {
    this.state = STATES.CLOSED;
    this.failureCount = 0;
    this.nextAttemptTime = null;
  }
}

module.exports = { CircuitBreaker, STATES };
