const path = require('path');

/**
 * Limpia una cadena para que sea segura como nombre de archivo o carpeta en Windows/Linux.
 * Elimina caracteres no permitidos como: < > : " / \ | ? *
 * Reemplaza caracteres de control y recorta espacios extremos.
 */
function sanitizeFilename(filename) {
  if (typeof filename !== 'string') return '';
  
  // Reemplazar caracteres prohibidos por guiones bajos
  let sanitized = filename.replace(/[<>:"/\\|?*]/g, '_');
  
  // Quitar caracteres no imprimibles o de control
  sanitized = sanitized.replace(/[\x00-\x1F\x7F]/g, '');
  
  // Recortar espacios y reemplazar múltiples espacios consecutivos por uno solo
  sanitized = sanitized.replace(/\s+/g, ' ').trim();
  
  // Evitar nombres de archivo vacíos o puntos suspensivos que puedan causar problemas
  if (!sanitized || sanitized === '.' || sanitized === '..') {
    return 'archivo_sin_nombre';
  }
  
  return sanitized;
}

/**
 * Verifica de forma segura que una ruta de destino está estrictamente dentro de una ruta base.
 * Previene ataques de Path Traversal (ej. ../../etc/passwd) y de prefijo de ruta (ej. /mnt/trabajos-alt).
 * 
 * @param {string} targetPath Ruta destino a verificar
 * @param {string} basePath Ruta base permitida
 * @returns {string} Ruta absoluta de destino resuelta si es válida
 * @throws {Error} Si la ruta destino está fuera de la ruta base
 */
function ensurePathWithinBase(targetPath, basePath) {
  const resolvedBase = path.resolve(basePath);
  const resolvedTarget = path.resolve(targetPath);
  
  // Calcular la ruta relativa entre la base y el objetivo
  const relative = path.relative(resolvedBase, resolvedTarget);
  
  // Si la ruta relativa empieza con '..' o es una ruta absoluta independiente (ej. otra partición),
  // significa que se escapa del directorio base.
  const isSafe = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  
  if (!isSafe) {
    throw new Error(`Intento de Path Traversal detectado. Objetivo: "${resolvedTarget}" está fuera de la base: "${resolvedBase}"`);
  }
  
  return resolvedTarget;
}

module.exports = {
  sanitizeFilename,
  ensurePathWithinBase
};
