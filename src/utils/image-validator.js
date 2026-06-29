const path = require('path');
const config = require('../config');

/**
 * Extensiones de imagen permitidas por el middleware.
 * Se cargan desde la variable de entorno ALLOWED_IMAGE_EXTENSIONS (comma-separated)
 * o se usa el set por defecto definido en config.js.
 */
const ALLOWED_IMAGE_EXTENSIONS = new Set(config.ALLOWED_IMAGE_EXTENSIONS);

/**
 * Verifica si un nombre de archivo tiene una extensión de imagen permitida.
 * La comparación se hace en minúsculas para aceptar extensiones como .JPG, .Png, etc.
 *
 * @param {string} filename Nombre del archivo a verificar
 * @returns {boolean} true si la extensión está en la lista blanca, false en caso contrario
 */
function isAllowedImageExtension(filename) {
  if (!filename || typeof filename !== 'string') return false;

  const ext = path.extname(filename).toLowerCase();
  if (!ext) return false;

  return ALLOWED_IMAGE_EXTENSIONS.has(ext);
}

module.exports = {
  ALLOWED_IMAGE_EXTENSIONS,
  isAllowedImageExtension,
};
