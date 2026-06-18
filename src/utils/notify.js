const https = require('https');
const config = require('../config');
const { logger } = require('./logger');

const TELEGRAM_MAX_CHARS = 4000;

function escapeHtml(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Envía una notificación de error o alerta al canal/grupo de Telegram.
 * Utiliza HTML para dar un formato profesional con emojis y negrita.
 * No arroja excepciones para evitar romper la lógica de negocio; los errores de red se registran en logs.
 * 
 * @param {string} message Mensaje en formato texto o HTML
 * @returns {Promise<boolean>} true si el mensaje se envió con éxito, false en caso contrario
 */
async function sendTelegramNotification(message) {
  if (!config.HAS_TELEGRAM) {
    logger.debug('Notificación omitida (Telegram no configurado)');
    return false;
  }

  const safeMessage = message.length > TELEGRAM_MAX_CHARS
    ? message.substring(0, TELEGRAM_MAX_CHARS - 20) + '\n...(truncado)'
    : message;

  const token = config.TELEGRAM_BOT_TOKEN;
  const chatId = config.TELEGRAM_CHAT_ID;
  
  const payload = JSON.stringify({
    chat_id: chatId,
    text: safeMessage,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  });

  const options = {
    hostname: 'api.telegram.org',
    port: 443,
    path: `/bot${token}/sendMessage`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    },
    timeout: config.TELEGRAM_TIMEOUT_MS
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          logger.debug('🔔 Notificación enviada correctamente a Telegram.');
          resolve(true);
        } else {
          logger.error(`❌ Error en API de Telegram (HTTP ${res.statusCode}): ${body}`);
          resolve(false);
        }
      });
    });

    req.on('error', (err) => {
      logger.error('❌ Error de red al enviar notificación a Telegram:', err);
      resolve(false);
    });

    req.on('timeout', () => {
      req.destroy();
      logger.error('❌ Timeout de red al enviar notificación a Telegram.');
      resolve(false);
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Plantillas predefinidas para alertas comunes
 */
const notify = {
  send: sendTelegramNotification,

  /**
   * Alerta cuando el espacio en disco es insuficiente.
   * @param {number} freeMB Megabytes libres en disco
   * @param {number} requiredMB Megabytes mínimos requeridos
   * @returns {Promise<boolean>} true si se envió con éxito, false en caso contrario
   */
  async alertLowDisk(freeMB, requiredMB) {
    const icon = '🚨';
    const text = `${icon} <b>[ALERTA CRÍTICA] ESPACIO EN DISCO INSUFICIENTE</b>\n\n` +
      `<b>Servidor:</b> Incorutas Photo Sync\n` +
      `<b>Estado:</b> LAS DESCARGAS ESTÁN BLOQUEADAS\n` +
      `<b>Espacio libre:</b> <code>${parseFloat(freeMB).toFixed(2)} MB</code>\n` +
      `<b>Mínimo requerido:</b> <code>${requiredMB} MB</code>\n\n` +
      `<i>Por favor, libere espacio en el servidor de archivos (SMB) inmediatamente.</i>`;
    return sendTelegramNotification(text);
  },

  /**
   * Alerta cuando el storage/SMB no está montado.
   * @param {string} path Ruta esperada del almacenamiento SMB
   * @returns {Promise<boolean>} true si se envió con éxito, false en caso contrario
   */
  async alertSmbDisconnected(path) {
    const icon = '🔌';
    const text = `${icon} <b>[ALERTA CRÍTICA] ALMACENAMIENTO SMB DESMONTADO</b>\n\n` +
      `<b>Servidor:</b> Incorutas Photo Sync\n` +
      `<b>Estado:</b> NO SE PUEDE ACCEDER A LA RUTA BASE\n` +
      `<b>Ruta esperada:</b> <code>${escapeHtml(path)}</code>\n\n` +
      `<i>Verifique el estado del montaje SMB en el sistema operativo del middleware.</i>`;
    return sendTelegramNotification(text);
  },

  /**
   * Alerta cuando un Job falla por completo (agotados reintentos).
   * @param {string} jobId ID del trabajo fallido
   * @param {string} title Título del trabajo
   * @param {string} errorMsg Mensaje de error descriptivo
   * @returns {Promise<boolean>} true si se envió con éxito, false en caso contrario
   */
  async alertJobFailed(jobId, title, errorMsg) {
    const icon = '❌';
    const truncatedError = (errorMsg || '').length > 1000
      ? (errorMsg || '').substring(0, 1000) + '...(truncado)'
      : (errorMsg || '');
    const text = `${icon} <b>[ERROR EN SINCRONIZACIÓN]</b>\n\n` +
      `<b>Job ID:</b> <code>${escapeHtml(jobId)}</code>\n` +
      `<b>Proyecto:</b> <code>${escapeHtml(title)}</code>\n` +
      `<b>Error:</b> <pre>${escapeHtml(truncatedError)}</pre>\n\n` +
      `<i>Las fotos de este trabajo no pudieron ser descargadas completamente. El middleware reintentará cuando se reciba un nuevo evento o se ejecute el backfill.</i>`;
    return sendTelegramNotification(text);
  },

  /**
   * Alerta cuando el polling falla repetidamente.
   * @param {number} consecutiveFailures Número de fallos consecutivos
   * @param {string} lastError Último mensaje de error
   * @param {string} cycleType Tipo de ciclo ('approved' o 'paid')
   * @returns {Promise<boolean>} true si se envió con éxito, false en caso contrario
   */
  async alertPollingFailure(consecutiveFailures, lastError, cycleType) {
    const icon = '🔁';
    const truncatedError = (lastError || '').length > 1000
      ? (lastError || '').substring(0, 1000) + '...(truncado)'
      : (lastError || '');
    const text = `${icon} <b>[ALERTA] POLLING REPETIDO FALLIDO</b>\n\n` +
      `<b>Servidor:</b> Incorutas Photo Sync\n` +
      `<b>Ciclo:</b> <code>${escapeHtml(cycleType)}</code>\n` +
      `<b>Fallos consecutivos:</b> <code>${consecutiveFailures}</code>\n` +
      `<b>Último error:</b> <pre>${escapeHtml(truncatedError)}</pre>\n\n` +
      `<i>El polling no está encolando jobs nuevos. Verifica Supabase / red.</i>`;
    return sendTelegramNotification(text);
  },

  /**
   * Notificación cuando se inicia el servidor.
   * @param {number|string} port Puerto de escucha del servidor
   * @param {string} mode Modo de ejecución ('Desarrollo' o 'Producción')
   * @param {boolean} smbStatus true si el almacenamiento SMB está montado
   * @returns {Promise<boolean>} true si se envió con éxito, false en caso contrario
   */
  async notifyStartup(port, mode, smbStatus) {
    const icon = '🚀';
    const text = `${icon} <b>Middleware Incorutas Photo Sync Iniciado</b>\n\n` +
      `<b>Puerto:</b> <code>${port}</code>\n` +
      `<b>Modo:</b> <code>${mode}</code>\n` +
      `<b>SMB Montado:</b> ${smbStatus ? '✅ Sí' : '❌ No'}\n` +
      `<b>Timestamp:</b> <code>${new Date().toLocaleString('es-ES')}</code>`;
    return sendTelegramNotification(text);
  }
};

module.exports = notify;
