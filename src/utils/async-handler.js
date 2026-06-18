/**
 * Wrapper para manejar errores async en rutas Express.
 * Evita tener que envolver cada handler en try/catch.
 * Los errores lanzados en funciones async se propagan al error handler centralizado.
 *
 * @param {Function} fn - Async route handler
 * @returns {Function} Express middleware wrapper
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;