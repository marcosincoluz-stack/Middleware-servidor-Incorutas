const https = require('https');
const os = require('os');
const config = require('../config');
const { logger } = require('./logger');

const TELEGRAM_MAX_CHARS = 4000;
const SEPARATOR = '━━━━━━━━━━━━━━━━━━━━━';

function escapeHtml(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getTimestamp() {
  return new Date().toLocaleString('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function getHostname() {
  return escapeHtml(os.hostname());
}

function formatUptime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function padLabel(label, width = 10) {
  return label.padEnd(width, ' ');
}

function buildAlert(emoji, title, fields, action = null) {
  let text = `${emoji} <b>Incorutas Photo Sync — ${title}</b>\n\n`;
  text += `${SEPARATOR}\n`;

  for (const [label, value] of fields) {
    text += `<b>${padLabel(label)}</b> ${value}\n`;
  }

  text += `${SEPARATOR}\n`;
  text += `<b>${padLabel('Hora')}</b> ${getTimestamp()}\n`;
  text += `<b>${padLabel('Servidor')}</b> ${getHostname()}\n`;

  if (action) {
    text += `\n<b>Acción:</b> ${action}`;
  }

  return text;
}

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

const notify = {
  send: sendTelegramNotification,

  async alertLowDisk(freeMB, requiredMB) {
    const text = buildAlert(
      '🔴',
      'DISCO CRÍTICO',
      [
        ['Estado', 'DESCARGAS BLOQUEADAS'],
        ['Libre', `<code>${parseFloat(freeMB).toFixed(2)} MB</code>`],
        ['Mínimo', `<code>${requiredMB} MB</code>`],
        ['Ruta', `<code>${escapeHtml(config.TRABAJOS_BASE_PATH)}</code>`]
      ],
      'Liberar espacio en SRV-2019 inmediatamente'
    );
    return sendTelegramNotification(text);
  },

  async alertDiskWarning(freeMB, requiredMB) {
    const text = buildAlert(
      '🟡',
      'DISCO BAJO',
      [
        ['Estado', 'Acercándose al umbral crítico'],
        ['Libre', `<code>${parseFloat(freeMB).toFixed(2)} MB</code>`],
        ['Mínimo', `<code>${requiredMB} MB</code>`],
        ['Ruta', `<code>${escapeHtml(config.TRABAJOS_BASE_PATH)}</code>`]
      ],
      'Se recomienda liberar espacio pronto'
    );
    return sendTelegramNotification(text);
  },

  async alertSmbDisconnected(path) {
    const text = buildAlert(
      '🔴',
      'SMB DESMONTADO',
      [
        ['Estado', 'No se puede acceder a la ruta base'],
        ['Ruta', `<code>${escapeHtml(path)}</code>`]
      ],
      'Verificar el montaje SMB en el sistema operativo'
    );
    return sendTelegramNotification(text);
  },

  async alertJobFailed(jobId, title, errorMsg) {
    const truncatedError = (errorMsg || '').length > 500
      ? (errorMsg || '').substring(0, 500) + '...(truncado)'
      : (errorMsg || '');

    const text = buildAlert(
      '🔴',
      'JOB FALLIDO',
      [
        ['Proyecto', `<code>${escapeHtml(title)}</code>`],
        ['Job ID', `<code>${escapeHtml(jobId)}</code>`],
        ['Intentos', '3/3 (agotados)'],
        ['Error', `<pre>${escapeHtml(truncatedError)}</pre>`]
      ],
      'Revisar desde el dashboard o reintentar manualmente'
    );
    return sendTelegramNotification(text);
  },

  async alertPollingFailure(consecutiveFailures, lastError, cycleType) {
    const truncatedError = (lastError || '').length > 500
      ? (lastError || '').substring(0, 500) + '...(truncado)'
      : (lastError || '');

    const text = buildAlert(
      '🟡',
      'POLLING FALLIDO',
      [
        ['Ciclo', `<code>${escapeHtml(cycleType)}</code>`],
        ['Fallos', `<code>${consecutiveFailures} consecutivos</code>`],
        ['Error', `<pre>${escapeHtml(truncatedError)}</pre>`]
      ],
      'Verificar conexión con Supabase / red'
    );
    return sendTelegramNotification(text);
  },

  async notifyStartup(port, mode, smbStatus, isAutoRestart = false) {
    const fields = [
      ['Puerto', `<code>${port}</code>`],
      ['Modo', `<code>${mode}</code>`],
      ['SMB', smbStatus ? '✅ Conectado' : '❌ Desconectado'],
      ['Redis', '✅ Conectado'],
      ['Versión', `<code>${config.NODE_ENV === 'production' ? 'v2.0.0' : 'dev'}</code>`]
    ];
    
    if (isAutoRestart) {
      fields.push(['Restart', '⚠️ Automático (crash detectado)']);
    }
    
    const text = buildAlert('🟢', 'INICIO', fields);
    return sendTelegramNotification(text);
  },

  async notifyShutdown(signal, uptimeSeconds) {
    const uptimeStr = formatUptime(uptimeSeconds);
    const text = buildAlert(
      '🟠',
      'APAGADO',
      [
        ['Motivo', `<code>${signal}</code>`],
        ['Uptime', uptimeStr]
      ]
    );
    return sendTelegramNotification(text);
  }
};

module.exports = { ...notify, buildAlert };
