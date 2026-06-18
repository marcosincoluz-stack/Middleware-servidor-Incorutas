const { randomUUID } = require('crypto');
const { asyncLocalStorage } = require('../utils/logger');

/**
 * Middleware que genera un request ID único para cada petición.
 * Añade req.id, lo incluye en las cabeceras de respuesta,
 * y lo almacena en AsyncLocalStorage para que esté disponible
 * en todas las llamadas al logger durante esta petición.
 *
 * @param {import('express').Request} req Petición HTTP
 * @param {import('express').Response} res Respuesta HTTP
 * @param {import('express').NextFunction} next Siguiente middleware
 */
function requestId(req, res, next) {
  const id = randomUUID();
  req.id = id;
  res.setHeader('X-Request-Id', id);

  asyncLocalStorage.run(id, () => {
    next();
  });
}

module.exports = requestId;