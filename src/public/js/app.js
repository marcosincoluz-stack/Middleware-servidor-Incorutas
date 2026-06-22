/* eslint-disable no-unused-vars */
const API_BASE = window.location.origin + '/v1';
const REFRESH_INTERVAL = 5000;

let currentJobStarted = null;
let currentJobTimer = null;

// --- Autenticación por Token ---
function getAuthToken() {
  return sessionStorage.getItem('api_token') || '';
}

function setAuthToken(token) {
  if (token) {
    sessionStorage.setItem('api_token', token);
  } else {
    sessionStorage.removeItem('api_token');
  }
}

function showAuthModal() {
  document.getElementById('authModal').classList.add('auth-modal--show');
  document.getElementById('authInput').focus();
}

function hideAuthModal() {
  document.getElementById('authModal').classList.remove('auth-modal--show');
  document.getElementById('authError').style.display = 'none';
}

function submitToken() {
  const token = document.getElementById('authInput').value.trim();
  if (!token) return;
  setAuthToken(token);
  hideAuthModal();
  document.getElementById('authInput').value = '';
  // Recargar datos inmediatamente con el nuevo token
  fetchData();
  fetchLogs();
}

const abortControllers = {};

function cancelPendingRequest(key) {
  if (abortControllers[key]) {
    abortControllers[key].abort();
    delete abortControllers[key];
  }
}

async function authFetch(url, options = {}, key = null) {
  const token = getAuthToken();
  options.headers = options.headers || {};
  if (token) {
    options.headers['Authorization'] = `Bearer ${token}`;
  }

  if (key) {
    cancelPendingRequest(key);
    const controller = new AbortController();
    abortControllers[key] = controller;
    options.signal = controller.signal;
  }

  try {
    const res = await fetch(url, options);
    if (res.status === 401) {
      setAuthToken('');
      document.getElementById('authError').style.display = 'block';
      showAuthModal();
      throw new Error('No autorizado');
    }
    return res;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw err;
    }
    throw err;
  } finally {
    if (key && abortControllers[key] && options.signal === abortControllers[key].signal) {
      delete abortControllers[key];
    }
  }
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

function formatMB(mb) {
  const num = parseFloat(mb);
  if (num >= 1024) return `${(num / 1024).toFixed(1)} GB`;
  return `${num.toFixed(0)} MB`;
}

function formatRelativeTime(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 5) return 'hace unos instantes';
  if (diffSec < 60) return `hace ${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `hace ${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `hace ${diffHr}h`;
  const diffDays = Math.floor(diffHr / 24);
  return `hace ${diffDays}d`;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function startCurrentJobTimer(startedAtIso) {
  currentJobStarted = new Date(startedAtIso);
  if (currentJobTimer) clearInterval(currentJobTimer);
  
  function updateDuration() {
    if (!currentJobStarted) return;
    const now = new Date();
    const diffMs = now - currentJobStarted;
    const diffSec = Math.floor(diffMs / 1000);
    
    let text = '';
    if (diffSec < 60) {
      text = `hace ${diffSec}s`;
    } else {
      const diffMin = Math.floor(diffSec / 60);
      const remSec = diffSec % 60;
      text = `hace ${diffMin}m ${remSec}s`;
    }
    document.getElementById('currentJobTime').textContent = text;
  }
  
  updateDuration();
  currentJobTimer = setInterval(updateDuration, 1000);
}

function stopCurrentJobTimer() {
  currentJobStarted = null;
  if (currentJobTimer) {
    clearInterval(currentJobTimer);
    currentJobTimer = null;
  }
}

function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  const icon = document.getElementById('toastIcon');
  const msg = document.getElementById('toastMessage');

  const icons = {
    success: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: hsl(var(--success))"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>`,
    error: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: hsl(var(--destructive))"><circle cx="12" cy="12" r="10"/><line x1="15" x2="9" y1="9" y2="15"/><line x1="9" x2="15" y1="9" y2="15"/></svg>`,
    info: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: hsl(var(--muted-foreground))"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`
  };

  toast.className = `toast toast--show toast--${type}`;
  icon.innerHTML = icons[type] || icons.info;
  msg.textContent = message;

  if (window.toastTimeout) clearTimeout(window.toastTimeout);
  
  window.toastTimeout = setTimeout(() => {
    toast.classList.remove('toast--show');
  }, 4000);
}

async function fetchData() {
  try {
    const res = await authFetch(`${API_BASE}/api/dashboard`, {}, 'dashboard');
    const data = await res.json();

    // ── 1. Status Indicator ──
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    
    statusDot.className = 'status-dot';
    if (data.status === 'ok') {
      statusDot.classList.add('status-dot--ok');
      statusText.textContent = 'Sistema operativo';
    } else if (data.status === 'degraded') {
      statusDot.classList.add('status-dot--degraded');
      statusText.textContent = 'Estado degradado';
    } else {
      statusDot.classList.add('status-dot--error');
      statusText.textContent = 'Problemas detectados';
    }

    // ── 2. Stat Cards ──
    document.getElementById('statUptime').textContent = formatUptime(data.process.uptime);
    document.getElementById('statProcessed').textContent = data.queue.totalProcessed;
    document.getElementById('statPhotos').textContent = data.queue.totalPhotos;
    document.getElementById('statErrors').textContent = data.queue.totalErrors;

    // Subtextos de sesión y fecha de inicio histórico
    const firstStartedDate = data.process.startedAt ? new Date(data.process.startedAt) : null;
    if (firstStartedDate) {
      const options = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
      document.getElementById('statUptimeSub').textContent = `Iniciado: ${firstStartedDate.toLocaleDateString('es-ES', options)}`;
    } else {
      document.getElementById('statUptimeSub').textContent = '—';
    }
    document.getElementById('statProcessedSub').textContent = `En sesión: ${data.queue.sessionProcessed}`;
    document.getElementById('statPhotosSub').textContent = `En sesión: ${data.queue.sessionPhotos}`;
    document.getElementById('statErrorsSub').textContent = `En sesión: ${data.queue.sessionErrors}`;

    // ── 3. Health Card ──
    // SMB status
    const smbEl = document.getElementById('infoSmb');
    if (data.health.smb) {
      smbEl.innerHTML = '<span class="badge badge--success">Conectado</span>';
    } else {
      smbEl.innerHTML = '<span class="badge badge--destructive">Desconectado</span>';
    }

    // Supabase status
    const dbEl = document.getElementById('infoSupabase');
    if (data.health.supabase) {
      dbEl.innerHTML = '<span class="badge badge--success">Conectado</span>';
    } else {
      dbEl.innerHTML = '<span class="badge badge--destructive">Desconectado</span>';
    }

    // Disk space
    const diskEl = document.getElementById('infoDiskFree');
    const diskBarContainer = document.getElementById('diskBarContainer');
    const diskBarFill = document.getElementById('diskBarFill');
    
    if (data.health.disk) {
      const freeMB = data.health.disk.freeMB;
      const minMB = data.health.minDiskMB;
      diskEl.textContent = formatMB(freeMB);
      
      diskBarContainer.style.display = 'block';
      const percent = Math.min(100, (freeMB / (freeMB + minMB)) * 100);
      diskBarFill.style.width = `${percent}%`;
      
      diskBarFill.className = 'disk-bar__fill';
      if (freeMB < minMB) {
        diskBarFill.classList.add('disk-bar__fill--danger');
      } else if (freeMB < minMB * 3) {
        diskBarFill.classList.add('disk-bar__fill--warning');
      }
    } else {
      diskEl.textContent = '—';
      diskBarContainer.style.display = 'none';
    }

    // Config section in Health Card
    document.getElementById('infoMode').innerHTML = data.config.devMode
      ? '<span class="badge badge--warning">Desarrollo</span>'
      : '<span class="badge badge--secondary">Producción</span>';
        
    document.getElementById('infoFolderMove').innerHTML = data.config.folderMove
      ? '<span class="badge badge--success">Activado</span>'
      : '<span class="badge badge--secondary">Desactivado</span>';
        
    document.getElementById('infoTelegram').innerHTML = data.config.telegram
      ? '<span class="badge badge--success">Activo</span>'
      : '<span class="badge badge--secondary">Inactivo</span>';

    document.getElementById('infoMemory').textContent = `${data.process.memoryMB} MB`;
    document.getElementById('infoVersion').textContent = `v${data.process.version}`;

    // ── 4. Queue Card ──
    const queueBadge = document.getElementById('queueBadge');
    if (data.queue.isProcessing) {
      queueBadge.innerHTML = '<span class="badge badge--warning">Procesando</span>';
    } else {
      queueBadge.innerHTML = '<span class="badge badge--secondary">En espera</span>';
    }

    document.getElementById('queuePendingCount').textContent = data.queue.pendingCount;

    // Current job section
    const currentJobSection = document.getElementById('currentJobSection');
    if (data.queue.isProcessing && data.queue.currentJob) {
      currentJobSection.style.display = 'block';
      document.getElementById('currentJobTitle').textContent = data.queue.currentJob.title || data.queue.currentJob.jobId;
      
      if (data.queue.currentJobStartedAt) {
        startCurrentJobTimer(data.queue.currentJobStartedAt);
      } else {
        document.getElementById('currentJobTime').textContent = 'iniciado';
        stopCurrentJobTimer();
      }
    } else {
      currentJobSection.style.display = 'none';
      stopCurrentJobTimer();
    }

    // Recent jobs list
    const recentJobsList = document.getElementById('recentJobsList');
    recentJobsList.innerHTML = '';
    
    if (data.queue.recentJobs && data.queue.recentJobs.length > 0) {
      data.queue.recentJobs.forEach(job => {
        const item = document.createElement('div');
        item.className = 'recent-job';
        
        const dotClass = job.status === 'success' ? 'recent-job__dot--success' : 'recent-job__dot--failed';
        const relativeTime = formatRelativeTime(job.finishedAt);
        const statusTooltip = job.status === 'success' ? 'Éxito' : `Fallo: ${job.error || 'Desconocido'}`;
        
        item.innerHTML = `
          <div class="recent-job__left" title="${statusTooltip}">
            <span class="recent-job__dot ${dotClass}"></span>
            <span class="recent-job__title">${job.title || job.jobId}</span>
          </div>
          <span class="recent-job__time">${relativeTime}</span>
        `;
        recentJobsList.appendChild(item);
      });
    } else {
      recentJobsList.innerHTML = '<div class="recent-jobs__empty">Sin actividad reciente</div>';
    }

  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('Error fetching data:', err);
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    statusDot.className = 'status-dot status-dot--error';
    statusText.textContent = 'Sin conexión';
  }
}

async function fetchLogs() {
  try {
    const res = await authFetch(`${API_BASE}/api/logs`, {}, 'logs');
    const data = await res.json();
    
    const consoleEl = document.getElementById('terminalConsole');
    const fileNameEl = document.getElementById('logFileName');
    
    if (data.file) {
      fileNameEl.textContent = data.file;
    }

    if (data.logs && data.logs.length > 0) {
      const wasAtBottom = consoleEl.scrollHeight - consoleEl.clientHeight <= consoleEl.scrollTop + 40;
      
      const coloredLines = data.logs.map(line => {
        if (line.includes('[ERROR]')) {
          return `<span style="color: hsl(var(--destructive))">${escapeHtml(line)}</span>`;
        } else if (line.includes('[WARN]')) {
          return `<span style="color: hsl(var(--warning))">${escapeHtml(line)}</span>`;
        } else if (line.includes('[INFO]') && line.includes('✔')) {
          return `<span style="color: hsl(var(--success))">${escapeHtml(line)}</span>`;
        } else if (line.includes('[DEBUG]')) {
          return `<span style="color: hsl(var(--muted-foreground))">${escapeHtml(line)}</span>`;
        }
        return `<span>${escapeHtml(line)}</span>`;
      });
      
      consoleEl.innerHTML = coloredLines.join('\n');
      
      if (wasAtBottom || consoleEl.scrollTop === 0) {
        consoleEl.scrollTop = consoleEl.scrollHeight;
      }
    } else {
      consoleEl.textContent = 'No hay logs de sistema disponibles aún.';
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('Error fetching logs:', err);
    document.getElementById('terminalConsole').textContent = 'Error al recuperar logs del sistema: ' + err.message;
  }
}

async function triggerBackfill() {
  const btn = document.getElementById('btnBackfill');
  const originalHTML = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<svg class="animate-spin" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg> Ejecutando...`;
  
  try {
    const res = await authFetch(`${API_BASE}/api/backfill`, { method: 'POST' });
    const data = await res.json();
    
    if (data.success) {
      showToast(data.message, 'success');
    } else {
      showToast(data.error || 'Ocurrió un error inesperado.', 'error');
    }
  } catch (err) {
    showToast('Fallo en la comunicación con el servidor: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHTML;
    fetchData();
  }
}

async function triggerTestTelegram() {
  const btn = document.getElementById('btnTestTelegram');
  const originalHTML = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<svg class="animate-spin" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg> Enviendo...`;
  
  try {
    const res = await authFetch(`${API_BASE}/api/test-telegram`, { method: 'POST' });
    const data = await res.json();
    
    if (data.success) {
      showToast(data.message, 'success');
    } else {
      showToast(data.error || 'Fallo al enviar alerta.', 'error');
    }
  } catch (err) {
    showToast('Error conectando con la API: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHTML;
  }
}

async function fetchDlq() {
  try {
    const res = await authFetch(`${API_BASE}/api/dlq`, {}, 'dlq');
    const data = await res.json();
    
    const dlqSection = document.getElementById('dlqSection');
    const dlqJobsList = document.getElementById('dlqJobsList');
    
    if (data.success && data.jobs && data.jobs.length > 0) {
      dlqSection.style.display = 'block';
      dlqJobsList.innerHTML = '';
      
      data.jobs.forEach(job => {
        const item = document.createElement('div');
        item.className = 'recent-job';
        item.style.padding = '0.75rem';
        item.style.display = 'flex';
        item.style.flexDirection = 'column';
        item.style.alignItems = 'stretch';
        item.style.gap = '0.5rem';
        
        const relativeTime = formatRelativeTime(job.failedAt);
        
        item.innerHTML = `
          <div style="display: flex; justify-content: space-between; align-items: center; gap: 1rem;">
            <div class="recent-job__left" style="min-width: 0; flex-grow: 1;">
              <span class="recent-job__dot recent-job__dot--failed"></span>
              <span class="recent-job__title" style="font-weight: 600;" title="${job.title || job.jobId}">${job.title || job.jobId}</span>
              <span class="badge badge--secondary" style="font-size: 0.65rem; flex-shrink: 0;">${job.event}</span>
              <span class="badge badge--destructive" style="font-size: 0.65rem; flex-shrink: 0;">Intentos: ${job.attemptsMade}</span>
            </div>
            <button class="btn btn--default" style="font-size: 0.7rem; padding: 0.25rem 0.6rem; flex-shrink: 0;" onclick="retryJob('${job.bullJobId}')">
              Reintentar
            </button>
          </div>
          <div style="font-size: 0.72rem; color: hsl(var(--destructive)); font-family: monospace; background-color: rgba(239, 68, 68, 0.05); padding: 0.5rem; border-radius: calc(var(--radius) - 4px); border: 1px solid rgba(239, 68, 68, 0.1); white-space: pre-wrap; word-break: break-all;">
            ${escapeHtml(job.error || 'Error desconocido')}
          </div>
          <div style="font-size: 0.65rem; color: hsl(var(--muted-foreground)); text-align: right;">
            Falló ${relativeTime}
          </div>
        `;
        dlqJobsList.appendChild(item);
      });
    } else {
      dlqSection.style.display = 'none';
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('Error fetching DLQ:', err);
  }
}

async function retryJob(bullJobId) {
  try {
    const res = await authFetch(`${API_BASE}/api/dlq/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bullJobId })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Trabajo reencolado con éxito', 'success');
      fetchDlq();
      fetchData();
    } else {
      showToast(data.error || 'Error al reintentar trabajo', 'error');
    }
  } catch (err) {
    showToast('Error en la petición: ' + err.message, 'error');
  }
}

async function clearDlq() {
  if (!confirm('¿Seguro que deseas vaciar todos los trabajos fallidos?')) return;
  try {
    const res = await authFetch(`${API_BASE}/api/dlq/clear`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('DLQ vaciada correctamente', 'success');
      fetchDlq();
    } else {
      showToast(data.error || 'Error al vaciar DLQ', 'error');
    }
  } catch (err) {
    showToast('Error en la petición: ' + err.message, 'error');
  }
}

function formatFailedCounts(job) {
  const parts = [];
  if (job.failedPhotos > 0) {
    parts.push(`${job.failedPhotos} foto${job.failedPhotos > 1 ? 's' : ''}`);
  }
  if (job.failedSignatures > 0) {
    parts.push(`${job.failedSignatures} acta${job.failedSignatures > 1 ? 's' : ''}`);
  }
  return parts.join(', ') || `${job.failedCount} evidencia${job.failedCount > 1 ? 's' : ''}`;
}

async function fetchFailedEvidences() {
  try {
    const res = await authFetch(`${API_BASE}/api/failed-evidences`, {}, 'failed-ev');
    const data = await res.json();

    const section = document.getElementById('failedEvSection');
    const list = document.getElementById('failedEvList');
    const badge = document.getElementById('failedEvBadge');

    if (data.success && data.jobs && data.jobs.length > 0) {
      section.style.display = 'block';
      badge.innerHTML = `<span class="badge badge--warning">${data.jobs.length} job${data.jobs.length > 1 ? 's' : ''}</span>`;
      list.innerHTML = '';

      data.jobs.forEach(job => {
        const item = document.createElement('div');
        item.className = 'recent-job';
        item.style.flexDirection = 'column';
        item.style.alignItems = 'stretch';
        item.style.gap = '0.5rem';
        item.style.padding = '0.75rem';

        item.innerHTML = `
          <div style="display: flex; justify-content: space-between; align-items: center; gap: 1rem;">
            <div class="recent-job__left" style="min-width: 0; flex-grow: 1;">
              <span class="recent-job__dot recent-job__dot--failed"></span>
              <span class="recent-job__title" style="font-weight: 600;" title="${escapeHtml(job.title)}">${escapeHtml(job.title)}</span>
              <span class="badge badge--warning" style="font-size: 0.65rem; flex-shrink: 0;">${formatFailedCounts(job)}</span>
            </div>
            <button class="btn btn--default" style="font-size: 0.7rem; padding: 0.25rem 0.6rem; flex-shrink: 0;" onclick="retryFailed('${job.jobId}', this)">
              Reintentar
            </button>
          </div>
        `;
        list.appendChild(item);
      });
    } else {
      section.style.display = 'none';
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('Error fetching failed evidences:', err);
  }
}

async function retryFailed(jobId, btn) {
  const originalHTML = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<svg class="animate-spin" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg> Reintentando...`;

  try {
    const res = await authFetch(`${API_BASE}/api/retry-failed/${jobId}`, { method: 'POST' });
    const data = await res.json();

    if (data.success) {
      const msg = `Reintento completado: ${data.succeeded} recuperada${data.succeeded !== 1 ? 's' : ''}${data.stillFailed > 0 ? `, ${data.stillFailed} a\u00fan fallida${data.stillFailed !== 1 ? 's' : ''}` : ''}`;
      showToast(msg, data.stillFailed > 0 ? 'info' : 'success');
      fetchFailedEvidences();
      fetchData();
    } else {
      showToast(data.error || 'Error al reintentar fotos fallidas', 'error');
    }
  } catch (err) {
    showToast('Error en la petici\u00f3n: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHTML;
  }
}

// Initial load
fetchData();
fetchDlq();
fetchFailedEvidences();
fetchLogs();

// Auto-refresh stats and logs
setInterval(() => {
  fetchData();
  fetchDlq();
  fetchFailedEvidences();
  fetchLogs();
}, REFRESH_INTERVAL);