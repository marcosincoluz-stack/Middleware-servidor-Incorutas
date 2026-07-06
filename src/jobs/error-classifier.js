const ERROR_CODES = {
  DISK_FULL: ['ENOSPC'],
  SMB_DISCONNECTED: ['EACCES', 'ENOTDIR', 'EIO', 'ECONNREFUSED', 'EHOSTUNREACH'],
  NETWORK: ['ECONNRESET', 'ETIMEDOUT', 'EPIPE'],
  FILE_LOCK: ['EBUSY', 'ELOCKED', 'EPERM'],
};

const ERROR_PATTERNS = {
  DISK_FULL: ['espacio en disco', 'ENOSPC'],
  SMB_DISCONNECTED: ['1ACTIVOS', 'TRABAJOS_BASE_PATH', 'readdir', 'SMB'],
};

const ACTION_MAP = {
  disk_full: 'alert_disk',
  smb_disconnected: 'alert_smb',
  network: 'retry',
  file_lock: 'retry',
};

/**
 * @typedef {{ type: 'disk_full' | 'smb_disconnected' | 'network' | 'file_lock' | 'unknown', action: 'alert_disk' | 'alert_smb' | 'retry' | 'none' }} ClassifyResult
 */

/**
 * Clasifica un error según códigos nativos de Node.js (prioridad)
 * o patrones de mensaje como fallback.
 *
 * @param {Error} err Error a clasificar
 * @returns {ClassifyResult}
 */
function classifyError(err) {
  if (err.code && typeof err.code === 'string') {
    for (const [type, codes] of Object.entries(ERROR_CODES)) {
      if (codes.includes(err.code)) {
        const lowerType = type.toLowerCase();
        return { type: lowerType, action: ACTION_MAP[lowerType] };
      }
    }
  }

  const msg = err.message || '';
  for (const [type, patterns] of Object.entries(ERROR_PATTERNS)) {
    if (patterns.some(p => msg.includes(p))) {
      const lowerType = type.toLowerCase();
      return { type: lowerType, action: ACTION_MAP[lowerType] };
    }
  }

  return { type: 'unknown', action: 'none' };
}

module.exports = { ERROR_CODES, ERROR_PATTERNS, classifyError };