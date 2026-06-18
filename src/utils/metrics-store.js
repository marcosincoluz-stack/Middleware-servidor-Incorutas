const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');

const METRICS_FILE = path.join(__dirname, '../../data/metrics.json');
const FLUSH_INTERVAL_MS = 60000; // 60 segundos

class MetricsStore {
  constructor() {
    this.metrics = {
      totalProcessed: 0,
      totalErrors: 0,
      totalPhotos: 0,
      firstStartedAt: new Date().toISOString()
    };
    
    // Métricas de la sesión actual (se reinician al arrancar el proceso)
    this.session = {
      startedAt: new Date().toISOString(),
      processed: 0,
      errors: 0,
      photos: 0
    };

    this.timer = null;
    this.load();
    this.startInterval();
  }

  load() {
    try {
      const dir = path.dirname(METRICS_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      if (fs.existsSync(METRICS_FILE)) {
        const data = fs.readFileSync(METRICS_FILE, 'utf8');
        const parsed = JSON.parse(data);

        const validated = {};
        for (const key of ['totalProcessed', 'totalErrors', 'totalPhotos']) {
          validated[key] = (typeof parsed[key] === 'number' && !Number.isNaN(parsed[key]))
            ? parsed[key]
            : 0;
        }
        validated.firstStartedAt = typeof parsed.firstStartedAt === 'string'
          ? parsed.firstStartedAt
          : new Date().toISOString();

        this.metrics = {
          ...this.metrics,
          ...validated
        };
        logger.info(`[MetricsStore] Métricas cargadas de disco: totalProcessed=${this.metrics.totalProcessed}, totalPhotos=${this.metrics.totalPhotos}`);
      } else {
        logger.info('[MetricsStore] No se encontró archivo de métricas. Creando uno inicial.');
        this.saveSync();
      }
    } catch (err) {
      logger.error('[MetricsStore] Error al cargar métricas de disco, iniciando con valores por defecto:', err.message);
    }
  }

  startInterval() {
    this.timer = setInterval(() => {
      this.flush();
    }, FLUSH_INTERVAL_MS);
    
    // Evitar que el temporizador bloquee la salida del proceso de Node
    if (this.timer && typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  incrementProcessed() {
    this.metrics.totalProcessed++;
    this.session.processed++;
  }

  incrementErrors() {
    this.metrics.totalErrors++;
    this.session.errors++;
  }

  addPhotos(count) {
    if (count > 0) {
      this.metrics.totalPhotos += count;
      this.session.photos += count;
    }
  }

  getMetrics() {
    return {
      historical: { ...this.metrics },
      session: { ...this.session }
    };
  }

  async flush() {
    try {
      const tempFile = `${METRICS_FILE}.tmp`;
      const data = JSON.stringify(this.metrics, null, 2);
      await fs.promises.writeFile(tempFile, data, 'utf8');
      await fs.promises.rename(tempFile, METRICS_FILE);
      logger.debug('[MetricsStore] Métricas guardadas periódicamente en disco.');
    } catch (err) {
      logger.error('[MetricsStore] Error al persistir métricas periódicas en disco:', err.message);
    }
  }

  saveSync() {
    try {
      const tempFile = `${METRICS_FILE}.tmp`;
      const data = JSON.stringify(this.metrics, null, 2);
      fs.writeFileSync(tempFile, data, 'utf8');
      fs.renameSync(tempFile, METRICS_FILE);
      logger.info('[MetricsStore] Métricas guardadas síncronamente en disco.');
    } catch (err) {
      logger.error('[MetricsStore] Error al persistir métricas síncronamente en disco:', err.message);
    }
  }

  shutdown() {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.saveSync();
  }
}

// Exportar instancia singleton
const metricsStore = new MetricsStore();
module.exports = { metricsStore };
