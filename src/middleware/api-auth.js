const crypto = require('crypto');
const config = require('../config');
const { logger } = require('../utils/logger');

/**
 * Middleware para validar que las peticiones a la API interna (/api/*)
 * incluyan un Bearer Token válido configurado en el entorno.
 * En modo desarrollo, si no hay token configurado, se permite el paso con una advertencia.
 *
 * @param {import('express').Request} req Petición HTTP
 * @param {import('express').Response} res Respuesta HTTP
 * @param {import('express').NextFunction} next Siguiente middleware
 */
function verifyApiToken(req, res, next) {
  // En modo desarrollo, si no está configurado un token, se permite el paso con una advertencia
  if (config.IS_DEV_MODE && !config.API_TOKEN) {
    logger.debug('Omitiendo verificación de API Token (Modo desarrollo activo y API_TOKEN no configurado)');
    return next();
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    logger.warn('Petición rechazada a API: Falta cabecera Authorization', { ip: req.ip, path: req.path });
    return res.status(401).json({ error: 'Falta token de autenticación (Authorization header requerido)' });
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    logger.warn('Petición rechazada a API: Formato de cabecera Authorization inválido', { ip: req.ip, path: req.path });
    return res.status(401).json({ error: 'Formato de autenticación inválido. Usar: Bearer <token>' });
  }

  const token = parts[1];
  const configuredToken = config.API_TOKEN;

  if (!configuredToken) {
    logger.error('Error de configuración: API_TOKEN no está definido en el servidor pero se requiere autenticación');
    return res.status(500).json({ error: 'Error interno de configuración del servidor' });
  }

  try {
    const tokenBuf = Buffer.from(token);
    const expectedBuf = Buffer.from(configuredToken);

    // Comparación en tiempo constante para evitar ataques de temporización (timing attacks)
    if (tokenBuf.length !== expectedBuf.length) {
      logger.warn('Petición rechazada a API: Longitud de token incorrecta', { ip: req.ip, path: req.path });
      return res.status(401).json({ error: 'Token de autenticación inválido' });
    }

    const isValid = crypto.timingSafeEqual(tokenBuf, expectedBuf);
    if (!isValid) {
      logger.warn('Petición rechazada a API: Token incorrecto', { ip: req.ip, path: req.path });
      return res.status(401).json({ error: 'Token de autenticación inválido' });
    }

    next();
  } catch (error) {
    logger.error('Error al verificar el token de la API:', error);
    return res.status(500).json({ error: 'Error interno de autenticación' });
  }
}

module.exports = { verifyApiToken };
