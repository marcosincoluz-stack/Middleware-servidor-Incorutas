const winston = require('winston');
require('winston-daily-rotate-file');
const config = require('../config');
const path = require('path');
const fs = require('fs');
const { AsyncLocalStorage } = require('async_hooks');

const asyncLocalStorage = new AsyncLocalStorage();

const logDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logDir)) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch (err) {
    console.error(`Error creando directorio de logs "${logDir}":`, err.message);
  }
}

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, stack, requestId }) => {
    const reqIdPart = requestId ? ` [${requestId}]` : '';
    return `[${timestamp}] [${level.toUpperCase()}]${reqIdPart}: ${message}${stack ? `\n${stack}` : ''}`;
  })
);

const logger = winston.createLogger({
  level: config.LOG_LEVEL,
  format: winston.format.combine(
    winston.format((info) => {
      const reqId = asyncLocalStorage.getStore();
      if (reqId) {
        info.requestId = reqId;
      }
      return info;
    })(),
    logFormat
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        logFormat
      )
    }),
    new winston.transports.DailyRotateFile({
      filename: path.join(logDir, 'sync-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d',
      level: 'info',
      auditFile: path.join(logDir, '.audit-sync.json')
    }),
    new winston.transports.DailyRotateFile({
      filename: path.join(logDir, 'errors-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '30d',
      level: 'error',
      auditFile: path.join(logDir, '.audit-errors.json')
    })
  ]
});

module.exports = { logger, asyncLocalStorage };
