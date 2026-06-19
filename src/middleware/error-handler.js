const { logger } = require('../utils/logger');

/**
 * Middleware centralizado de manejo de errores para Express.
 * Captura cualquier error no manejado en las rutas y devuelve una respuesta JSON consistente.
 *
 * @param {Error} err Error lanzado o pasado a next()
 * @param {import('express').Request} req Petición HTTP
 * @param {import('express').Response} res Respuesta HTTP
 * @param {import('express').NextFunction} _next Siguiente middleware (no utilizado)
 */
function errorHandler(err, req, res, _next) {
  const statusCode = err.statusCode || 500;
  const message = err.expose ? err.message : 'Error interno del servidor';

  if (statusCode >= 500) {
    logger.error(`Unhandled error on ${req.method} ${req.path}:`, err);
  } else {
    logger.warn(`Client error on ${req.method} ${req.path}: ${err.message}`);
  }

  if (res.headersSent) {
    logger.warn('Headers ya enviados, no se puede responder al cliente.');
    return;
  }

  res.status(statusCode).json({
    error: message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
}

module.exports = errorHandler;