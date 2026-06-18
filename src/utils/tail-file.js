const fs = require('fs');

const DEFAULT_MAX_LINES = 60;
const DEFAULT_MAX_BYTES = 65536;

/**
 * Lee las últimas N líneas de un archivo de forma eficiente.
 * Si el archivo es mayor que maxBytes, solo lee el último fragmento.
 *
 * @param {string} filePath Ruta absoluta al archivo
 * @param {{ maxLines?: number, maxBytes?: number }} options
 * @returns {Promise<string[]>} Array de líneas (sin líneas vacías)
 */
async function tailFile(filePath, { maxLines = DEFAULT_MAX_LINES, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return [];
  }

  const fileSize = stat.size;
  if (fileSize === 0) return [];

  if (fileSize <= maxBytes) {
    const content = await fs.promises.readFile(filePath, 'utf8');
    return content.split('\n').map(l => l.trim()).filter(l => l !== '').slice(-maxLines);
  }

  const start = fileSize - maxBytes;
  const stream = fs.createReadStream(filePath, { start, encoding: 'utf8' });

  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  const content = chunks.join('');
  let lines = content.split('\n').map(l => l.trim()).filter(l => l !== '');

  if (start > 0 && lines.length > 1) {
    lines = lines.slice(1);
  }

  return lines.slice(-maxLines);
}

module.exports = { tailFile, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES };