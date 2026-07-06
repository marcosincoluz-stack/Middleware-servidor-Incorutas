const path = require('path');
const config = require('../config');

/**
 * Extensiones permitidas para evidencias (imágenes + PDF).
 * Se cargan desde la variable de entorno ALLOWED_IMAGE_EXTENSIONS (comma-separated)
 * o se usa el set por defecto definido en config.js.
 */
const ALLOWED_IMAGE_EXTENSIONS = new Set(config.ALLOWED_IMAGE_EXTENSIONS);

/**
 * Verifica si un nombre de archivo tiene una extensión permitida (imagen o PDF).
 * La comparación se hace en minúsculas para aceptar extensiones como .JPG, .Png, etc.
 *
 * @param {string} filename Nombre del archivo a verificar
 * @returns {boolean} true si la extensión está en la lista blanca, false en caso contrario
 */
function isAllowedEvidenceExtension(filename) {
  if (!filename || typeof filename !== 'string') return false;

  const ext = path.extname(filename).toLowerCase();
  if (!ext) return false;

  return ALLOWED_IMAGE_EXTENSIONS.has(ext);
}

/**
 * Valida el contenido de un archivo descargado comprobando magic bytes.
 * - PDF: el buffer debe empezar con "%PDF-". Previene .exe disfrazados de .pdf.
 * - Imágenes: no se valida contenido (solo extensión, igual que antes).
 *
 * @param {Buffer} buffer Contenido del archivo descargado
 * @param {string} filename Nombre del archivo (para extraer la extensión)
 * @throws {Error} Si el contenido no coincide con lo esperado para la extensión
 */
function validateFileContent(buffer, filename) {
  if (!buffer || buffer.length === 0) return;

  const ext = path.extname(filename).toLowerCase();

  if (ext === '.pdf') {
    const head = buffer.subarray(0, 5).toString('latin1');
    if (head !== '%PDF-') {
      throw new Error(`El archivo "${filename}" no es un PDF válido: no empieza con "%PDF-" (encontrado: "${head}"). Posible archivo disfrazado.`);
    }
  }
}

/**
 * @deprecated Usar isAllowedEvidenceExtension en su lugar.
 * Alias para compatibilidad con código existente.
 */
const isAllowedImageExtension = isAllowedEvidenceExtension;

module.exports = {
  ALLOWED_IMAGE_EXTENSIONS,
  isAllowedEvidenceExtension,
  isAllowedImageExtension,
  validateFileContent,
};
