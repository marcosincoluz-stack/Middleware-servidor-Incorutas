const { logger } = require('../utils/logger');

/**
 * Middleware que registra cada petición HTTP completada.
 * Loguea método, path, status code y duración en ms.
 * Las peticiones a /health se omiten para no spammear los logs.
 *
 * @param {import('express').Request} req Petición HTTP
 * @param {import('express').Response} res Respuesta HTTP
 * @param {import('express').NextFunction} next Siguiente middleware
 */
function requestLogger(req, res, next) {
  if (req.path === '/health' || req.path === '/v1/health') {
    return next();
  }

  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    const { method, path: reqPath } = req;
    const { statusCode } = res;

    if (statusCode >= 500) {
      logger.error(`${method} ${reqPath} ${statusCode} ${duration}ms`);
    } else if (statusCode >= 400) {
      logger.warn(`${method} ${reqPath} ${statusCode} ${duration}ms`);
    } else {
      logger.info(`${method} ${reqPath} ${statusCode} ${duration}ms`);
    }
  });

  next();
}

module.exports = requestLogger;
