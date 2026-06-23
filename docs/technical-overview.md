# Incorutas Photo Sync — Documento Técnico de Arquitectura y Seguridad

**Versión:** 2.0.0  
**Fecha:** Junio 2026  
**Autor:** Marcos Incorutas  
**Audiencia:** Departamento de IT / Ciberseguridad  

---

## 1. Resumen Ejecutivo

Incorutas Photo Sync es un middleware Node.js (Express) desplegado en un servidor Ubuntu que sincroniza evidencias fotográficas (fotos y actas) desde Supabase Storage hacia el servidor de archivos local (SRV-2019 vía SMB). El sistema opera mediante polling saliente cada 30 segundos — **no expone puertos al exterior** y no requiere conexiones entrantes.

### Flujos de datos

```
Supabase (cloud)
  ↑
  | polling saliente cada 30s (HTTPS)
  |
Ubuntu Server (LAN)
  ├── Node.js middleware (PM2, puerto 3000 localhost)
  │    ├── Polling → consulta Supabase por jobs aprobados
  │    ├── BullMQ Worker → procesa jobs secuencialmente (concurrency: 1)
  │    ├── Auto-heal → re-descarga evidencias con local_path IS NULL
  │    ├── Disk monitor → alerta Telegram si disco baja
  │    └── Dashboard → monitoreo vía SSH tunnel
  ├── Redis 7 (Docker, puerto 6379 localhost)
  └── /mnt/trabajos (SMB mount de SRV-2019, auto-montado via fstab)
       ├── 1ACTIVOS/
       │    └── PXXXXXX - .../FOTOS/FOTOS TERMINADO/*.jpg
       └── TERMINADOS/
```

---

## 2. Arquitectura de Despliegue

### 2.1 Componentes

| Componente | Tecnología | Función |
|---|---|---|
| Middleware | Node.js 20 + Express 4 | Aplicación principal |
| Gestor de procesos | PM2 | Auto-restart, monitorización, logs |
| Cola de jobs | BullMQ 5 + Redis 7 | Persistencia, reintentos, DLQ |
| Redis | Docker (redis:7-alpine) | Cola BullMQ + locks distribuidos |
| Almacenamiento | SMB mount (SRV-2019) | Destino de fotos descargadas |
| Base de datos | Supabase (PostgreSQL cloud) | Jobs, evidence, estados |
| Storage | Supabase Storage | Bucket de fotos originales |
| Monitorización | Prometheus + Dashboard web | Métricas, logs, estado |
| Alertas | Telegram Bot | Notificaciones de sistema |

### 2.2 Auto-arranque tras reboot

La cadena completa de auto-arranque está configurada:

```
Servidor arranca
  → systemd inicia Docker (systemctl enable docker)
    → Docker inicia Redis (restart: unless-stopped)
  → systemd inicia PM2 (pm2-root.service)
    → PM2 restaura procesos (dump.pm2)
      → Middleware arranca y conecta a Redis
  → fstab monta SMB (nofail)
    → Middleware puede escribir en /mnt/trabajos
```

| Componente | Mecanismo | Verificación |
|---|---|---|
| Docker | `systemctl enable docker` | `systemctl is-enabled docker` |
| Redis | `restart: unless-stopped` en docker-compose | `docker inspect incorutas-redis --format '{{.HostConfig.RestartPolicy.Name}}'` |
| PM2 | `pm2-root.service` (systemd) | `systemctl is-enabled pm2-root` |
| Middleware | `dump.pm2` restaurado por PM2 | `pm2 list` |
| SMB mount | `/etc/fstab` con `nofail` | `grep trabajos /etc/fstab` |

### 2.3 Cierre graceful (SIGTERM/SIGINT)

Cuando el middleware recibe SIGTERM o SIGINT:

1. Deja de aceptar nuevas peticiones HTTP
2. Espera 2s y fuerza cierre de conexiones keep-alive (`server.closeAllConnections()`)
3. Detiene el polling y el disk monitor
4. Espera hasta 30s a que el job activo termine
5. Cierra BullMQ (worker + queue) y conexión Redis
6. Persiste métricas en disco (`metrics.json`)
7. Envía notificación de apagado a Telegram
8. Escribe timestamp de shutdown graceful (para detección de crashes)
9. `process.exit(0)`

Si el proceso no termina en 35s, PM2 fuerza el cierre (`process.exit(1)`).

### 2.4 Detección de crashes

- Cuando el middleware se apaga gracefulmente, escribe un timestamp en `data/.last_graceful_shutdown`
- Cuando arranca, verifica si el archivo existe y si el timestamp es reciente (< 60s)
- Si no existe o es viejo → fue un crash → el mensaje de startup a Telegram incluye "⚠️ Automático (crash detectado)"
- PM2 reinicia automáticamente el proceso tras un crash (`autorestart: true`)

---

## 3. Seguridad

### 3.1 Autenticación

| Mecanismo | Implementación | Ubicación |
|---|---|---|
| Bearer Token (API) | `crypto.timingSafeEqual()` — comparación en tiempo constante | `src/middleware/api-auth.js` |
| Token en frontend | `sessionStorage` (no `localStorage`) — se borra al cerrar pestaña | `src/public/js/app.js` |
| Acceso al dashboard | Solo vía SSH tunnel (`ssh -L 3000:localhost:3000`) | Configuración de red |
| Redis | `--requirepass` con password aleatoria de 24 bytes | `docker-compose.redis.yml` |

**Detalle del Bearer Token:**
- Generado con `openssl rand -hex 32` (64 caracteres hexadecimales)
- Almacenado en `.env` con `chmod 600` (solo usuario del servicio)
- Comparado con `crypto.timingSafeEqual()` para prevenir timing attacks
- Validación de longitud antes de comparar (los buffers deben tener la misma longitud)
- Si el token no está configurado en producción, el middleware no arranca (`config.js` validación)

### 3.2 Protección de la aplicación

| Medida | Implementación | Detalle |
|---|---|---|
| Helmet | Cabeceras HTTP de seguridad | `X-Content-Type-Options`, `X-Frame-Options`, `Strict-Transport-Security` |
| Sanitización de filenames | Elimina `<>:"/\|?*` y caracteres de control | `src/utils/sanitize.js` |
| Anti Path Traversal | `path.resolve()` + `path.relative()` verifica que la ruta destino esté dentro del base | `src/utils/sanitize.js` |
| Validación de input | Zod schemas con `.max()` en todos los campos string | `src/validations/` |
| Error handler centralizado | No expone stack traces en producción (`err.expose` flag) | `src/middleware/error-handler.js` |
| Rate limiting en backfill | 429 si hay ≥200 jobs pendientes | `src/routes/api.js` |
| Lock distribuido | Previene procesamiento duplicado del mismo job | `src/utils/lock.js` |
| Circuit breaker | Abre tras 5 fallos consecutivos de Supabase, reset a los 30s | `src/utils/circuit-breaker.js` |

### 3.3 Red y exposición

| Puerto | Bind | Accesible desde |
|---|---|---|
| 22 (SSH) | 0.0.0.0 | LAN (recomendado: key-only + fail2ban) |
| 3000 (Middleware) | 0.0.0.0 (recomendado: 127.0.0.1) | Solo localhost (vía SSH tunnel) |
| 6379 (Redis) | 127.0.0.1 | Solo localhost |

**No hay puertos abiertos al exterior.** El middleware hace llamadas salientes a Supabase (HTTPS) cada 30 segundos. Nadie puede conectar al servidor desde internet.

### 3.4 Gestión de secrets

| Secret | Almacenamiento | Acceso |
|---|---|---|
| `SUPABASE_SERVICE_KEY` | `.env` (chmod 600) | Solo `process.env` en `src/services/supabase.js` |
| `API_TOKEN` | `.env` (chmod 600) | `process.env` en `src/config.js` |
| `REDIS_PASSWORD` | `.env` (chmod 600) | `process.env` en `src/config.js` |
| `TELEGRAM_BOT_TOKEN` | `.env` (chmod 600) | `process.env` en `src/utils/notify.js` |

**La `service_role` key de Supabase NO se expone vía `config.js`** — se lee directamente de `process.env` en `src/services/supabase.js` para limitar el acceso.

**El archivo `.env`:**
- Está en `.gitignore` (no se commitea al repositorio)
- Tiene `chmod 600` (solo el usuario del servicio puede leerlo)
- No se incluye en Docker images (`.dockerignore`)

### 3.5 Logs y forensics

| Tipo | Ubicación | Rotación |
|---|---|---|
| Logs generales | `logs/sync-YYYY-MM-DD.log` | Winston, diario, 20MB max, 14 días |
| Logs de errores | `logs/errors-YYYY-MM-DD.log` | Winston, diario, 20MB max, 30 días |
| PM2 stdout/stderr | `/dev/null` | PM2 no escribe logs (Winston gestiona todo) |
| PM2 logrotate | Instalado como módulo | 10MB max, 7 días (redundancia) |

**Los logs incluyen:**
- Timestamp en formato ISO
- Nivel (INFO, WARN, ERROR)
- Request ID (UUID para correlación de logs)
- Method + Path + Status + Duration (para peticiones HTTP)
- Stack traces en errores (solo en archivo de error, no en response HTTP)

### 3.6 Endurecimiento pendiente

| Item | Prioridad | Estado |
|---|---|---|
| SSH key-only (sin password) | Alta | Pendiente |
| fail2ban | Alta | Pendiente |
| Firewall (ufw) | Alta | Pendiente |
| Rate limiting en Express | Alta | Pendiente |
| Fix XSS en dashboard | Alta | Pendiente |
| Reactivar CSP | Alta | Pendiente |
| Puerto 3000 a 127.0.0.1 | Alta | Pendiente |
| Usuario no-root para PM2 | Media | Pendiente |
| systemd credentials (tmpfs) | Media | Pendiente |
| Docker hardening (node:22, USER node) | Media | Pendiente |

---

## 4. Gestión de Procesos

### 4.1 PM2

PM2 gestiona el proceso Node.js con la siguiente configuración (`ecosystem.config.js`):

```js
{
  name: 'incorutas-photo-sync',
  script: 'src/index.js',
  instances: 1,
  autorestart: true,        // Reinicia automáticamente si crashea
  watch: false,             // No reinicia en cambios de archivo
  max_memory_restart: '200M', // Reinicia si supera 200MB de RAM
  env_production: {
    NODE_ENV: 'production'
  }
}
```

**Comandos de administración:**

| Acción | Comando |
|---|---|
| Ver estado | `pm2 status` |
| Ver logs | `pm2 logs incorutas-photo-sync --lines 50` |
| Reiniciar | `pm2 restart incorutas-photo-sync` |
| Detener | `pm2 stop incorutas-photo-sync` |
| Eliminar y recrear | `pm2 delete incorutas-photo-sync && pm2 start ecosystem.config.js --env production` |
| Guardar configuración | `pm2 save` |
| Auto-inicio tras reboot | `pm2 startup` (genera servicio systemd) |

### 4.2 Docker (Redis)

Redis corre en un contenedor Docker con la siguiente configuración (`docker-compose.redis.yml`):

```yaml
services:
  redis:
    image: redis:7-alpine
    container_name: incorutas-redis
    ports:
      - "127.0.0.1:6379:6379"    # Solo localhost
    volumes:
      - redis-data:/data          # Persistencia
    command: redis-server --appendonly yes --maxmemory 128mb --maxmemory-policy noeviction --requirepass ${REDIS_PASSWORD}
    restart: unless-stopped       # Auto-restart
```

**Características:**
- Puerto bindado a `127.0.0.1` (no accesible desde la red)
- Password obligatoria (`--requirepass`)
- Persistencia AOF (`--appendonly yes`) — los jobs sobreviven a reinicios
- Límite de memoria 128MB con política `noeviction` (no elimina datos, devuelve error)
- Auto-restart (`restart: unless-stopped`)

**Comandos:**

| Acción | Comando |
|---|---|
| Iniciar Redis | `docker compose -f docker-compose.redis.yml up -d` |
| Ver estado | `docker ps \| grep redis` |
| Ver logs | `docker logs incorutas-redis --tail 20` |
| Reiniciar | `docker compose -f docker-compose.redis.yml restart` |
| Limpiar cola | `docker exec incorutas-redis redis-cli -a <password> FLUSHDB` |

---

## 5. Flujo de Operación

### 5.1 Polling (cada 30s)

1. `pollApprovedJobs()` consulta Supabase: `status IN ('approved','paid') AND downloaded_at IS NULL`
2. Jobs encontrados se encolan en BullMQ (Redis) con deduplicación por `jobId`
3. `pollPaidJobs()` consulta jobs pagados para mover a TERMINADOS (si `ENABLE_FOLDER_MOVE=true`)
4. `pollStaleJobs()` busca jobs descargados con evidence pendiente (`local_path IS NULL`) y re-descarga

### 5.2 Procesamiento de jobs

1. BullMQ Worker procesa jobs secuencialmente (concurrency: 1, rate limit 1/1000ms)
2. **Lock distribuido** protege `processJobApproved` — dos instancias no pueden procesar el mismo job
3. Descarga evidencias (`type IN ('photo','signature')`) con `local_path IS NULL` desde Supabase Storage
4. Escribe archivos atómicamente (`.part` → rename on success)
5. Actualiza `local_path` en Supabase por cada evidencia
6. Si `updateEvidenceLocalPath` falla → el job **no** se marca como descargado → polling re-procesa
7. Marca `downloaded_at` solo si todas las evidencias se registraron correctamente
8. Si un job falla → BullMQ reintenta 3 veces con backoff exponencial (2s → 4s → 8s)
9. Si las 3 fallan → job va a DLQ para revisión manual

### 5.3 Auto-healing

`pollStaleJobs` corre cada 30s y:
1. Consulta jobs `approved/paid` con `downloaded_at NOT NULL` (ya descargados)
2. Filtra los que tienen evidence con `local_path IS NULL` (fotos/actas pendientes)
3. Llama `retryFailedEvidences()` para re-descargar solo lo faltante
4. Actualiza métricas (`metricsTracker.addPhotos`)

### 5.4 Circuit breaker

- Wraps `processJobApproved` y `moveJobToTerminados`
- Abre tras 5 fallos consecutivos de Supabase
- En estado OPEN: los jobs fallan rápido (no esperan timeout de Supabase)
- Reset a los 30s (estado HALF_OPEN) — permite un intento de prueba
- Si el intento funciona → CLOSE. Si falla → OPEN por 30s más

### 5.5 Stalled job detection

- BullMQ detecta jobs stalled cada 30s (`stalledInterval`)
- Lock duration: 60s (`lockDuration`)
- Si un job se queda stalled (worker crasheó mid-job), BullMQ lo reencola automáticamente

---

## 6. Monitorización y Alertas

### 6.1 Dashboard web

Accesible solo vía SSH tunnel (`ssh -L 3000:localhost:3000 admin@<server>`).

| Sección | Datos |
|---|---|
| Métricas | Jobs procesados, fotos descargadas, errores (histórico + sesión) |
| Salud | SMB, Supabase, disco, memoria, versión |
| Cola | Pendientes, en proceso, recientes |
| Evidencias pendientes | Jobs con fotos/actas sin descargar |
| DLQ | Jobs fallidos (reintentar, limpiar) |
| Consola de logs | Últimas 200 líneas (filtradas, sin ruido del dashboard) |
| Acciones | Backfill, probar Telegram |

### 6.2 Prometheus

`GET /metrics` expone métricas en formato Prometheus text (requiere API_TOKEN):

```
photo_sync_jobs_total{status="success"} 45
photo_sync_jobs_total{status="failed"} 3
photo_sync_photos_total 434
photo_sync_queue_pending 0
photo_sync_disk_free_mb 107900.00
photo_sync_process_uptime_seconds 86400
photo_sync_memory_bytes{type="rss"} 78643200
```

### 6.3 Telegram Bot

Bot unidireccional (solo envía alertas, no recibe comandos).

| Alerta | Cuándo se dispara | Severidad |
|---|---|---|
| INICIO | Middleware arranca | 🟢 INFO |
| APAGADO | Middleware se apaga gracefulfully | 🟠 AVISO |
| DISCO BAJO | Disco < 2x MIN_DISK_MB | 🟡 AVISO |
| DISCO CRÍTICO | Disco < MIN_DISK_MB | 🔴 CRÍTICO |
| SMB DESMONTADO | Job falla con error de SMB | 🔴 CRÍTICO |
| JOB FALLIDO | Job agota 3 reintentos | 🔴 CRÍTICO |
| POLLING FALLIDO | Polling falla 3 veces seguidas | 🟡 AVISO |

**Características del formato:**
- Branding consistente: `Incorutas Photo Sync — <TIPO>`
- Separadores visuales `━━━━━━━━━━━━━━━━━━━━━`
- Timestamp en formato español
- Hostname del servidor
- Sección "Acción" recomendada en alertas críticas
- Escape HTML en todos los campos dinámicos
- Truncado a 4000 caracteres (límite de Telegram)

### 6.4 Disk monitor

- Corre cada 5 minutos (`setInterval` con `unref`)
- Alerta crítica si `freeMB < MIN_DISK_MB` (descargas bloqueadas)
- Alerta de aviso si `freeMB < 2 * MIN_DISK_MB` (aviso temprano)
- Cooldown de 10 minutos entre alertas (evita spam)
- Se detiene en cierre graceful

---

## 7. Evidencias: Fotos y Actas

El middleware descarga dos tipos de evidencias:

| Type | Descripción | Carpeta destino |
|---|---|---|
| `photo` | Fotos de evidencia | `FOTOS/FOTOS TERMINADO/` |
| `signature` | Actas/firmas | `FOTOS/FOTOS TERMINADO/` (misma carpeta) |

### Idempotencia

- **A nivel job:** `downloaded_at` en Supabase — si ya está set, el job se salta
- **A nivel evidencia:** `local_path IS NULL` — solo se descargan evidencias pendientes
- **A nivel archivo:** `resolveUniqueFilename` — si el archivo existe, añade sufijo `(1)`, `(2)`, etc.
- **A nivel proceso:** Lock distribuido — previene que dos instancias procesen el mismo job

### Creación de carpetas

`resolveProjectPhotosFolder()`:
1. Extrae código del proyecto del título (ej: `P260251`)
2. Busca carpeta existente en `1ACTIVOS/` que empiece con el código
3. Si la encuentra → la reusa
4. Si no → la crea con formato `P260251 - Título sanitizado`
5. Crea `FOTOS/FOTOS TERMINADO/` con `mkdir({ recursive: true })` (idempotente)

---

## 8. Tests y CI/CD

### 8.1 Tests

- **Framework:** Vitest
- **Cobertura:** 231 tests en 23 suites
- **Estrategia de mocking:** `injectMock` + `require.cache` para módulos CJS
- **Tests de integración:** Servidor Express real en tests

| Suite | Tests | Cobertura |
|---|---|---|
| `bull-queue.test.js` | 15 | Cola BullMQ, worker events, DLQ |
| `downloader.test.js` | 27 | Descargas, idempotencia, retryFailedEvidences |
| `polling.test.js` | 22 | Polling, auto-heal, backpressure |
| `api.test.js` | 15 | Endpoints, auth, dashboard |
| `notify.test.js` | 16 | Telegram, escape HTML, truncado |
| `metrics-store.test.js` | 8 | Persistencia, NaN validation |
| `sanitize.test.js` | 6 | Path traversal, filename sanitization |
| Otras | 122 | DLQ handler, circuit breaker, lock, etc. |

### 8.2 CI/CD

- **Pipeline:** GitHub Actions
- **Steps:** ESLint → Vitest con coverage → Redis como service container
- **Pre-commit:** Husky + lint-staged ejecuta ESLint en `*.js`

### 8.3 Calidad de código

- ESLint: 0 errors, 0 warnings requeridos antes de merge
- JSDoc en todas las funciones públicas
- Convenciones documentadas en `AGENTS.md`

---

## 9. Configuración

### 9.1 Variables de entorno obligatorias

| Variable | Descripción | Ejemplo |
|---|---|---|
| `SUPABASE_URL` | URL del proyecto Supabase | `https://xxx.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Service role key de Supabase | `eyJ...` |
| `API_TOKEN` | Token de autenticación del dashboard | `openssl rand -hex 32` |
| `REDIS_PASSWORD` | Password de Redis | `openssl rand -hex 24` |
| `TRABAJOS_BASE_PATH` | Ruta del SMB montado | `/mnt/trabajos` |

### 9.2 Variables opcionales

| Variable | Default | Descripción |
|---|---|---|
| `PORT` | 3000 | Puerto del middleware |
| `NODE_ENV` | development | Entorno (production habilita validaciones) |
| `POLLING_ENABLED` | true | Habilita/deshabilita polling |
| `ENABLE_FOLDER_MOVE` | false | Mover carpetas a TERMINADOS |
| `MIN_DISK_MB` | 500 | Espacio mínimo en disco |
| `JOB_MAX_RETRIES` | 3 | Reintentos por job antes de DLQ |
| `JOB_BACKOFF_BASE_MS` | 2000 | Base del backoff exponencial |
| `TELEGRAM_BOT_TOKEN` | — | Token del bot de Telegram |
| `TELEGRAM_CHAT_ID` | — | Chat ID del grupo de notificaciones |
| `LOG_LEVEL` | info | Nivel de logging |
| `DOWNLOAD_TOLERANCE_PERCENT` | 0 | % de fotos fallidas toleradas |
| `CIRCUIT_BREAKER_THRESHOLD` | 5 | Fallos antes de abrir circuit breaker |
| `CIRCUIT_BREAKER_RESET_MS` | 30000 | Tiempo antes de half-open |

---

## 10. Comandos de administración

| Acción | Comando |
|---|---|
| Ver estado PM2 | `pm2 status` |
| Ver logs Winston | `pm2 logs incorutas-photo-sync --lines 50` |
| Ver logs filtrados | `pm2 logs --lines 200 --nostream \| grep -i "auto-heal\|polling\|error"` |
| Reiniciar middleware | `pm2 restart incorutas-photo-sync` |
| Health check | `curl http://localhost:3000/health` |
| Estado Redis | `docker ps \| grep redis` |
| Logs Redis | `docker logs incorutas-redis --tail 20` |
| Reiniciar Redis | `docker compose -f docker-compose.redis.yml restart` |
| Limpiar cola Redis | `docker exec incorutas-redis redis-cli -a <pass> FLUSHDB` |
| Actualizar middleware | `git pull origin main && npm ci --omit=dev && pm2 restart incorutas-photo-sync` |
| Guardar PM2 | `pm2 save` |

---

## 11. Roadmap de seguridad

### Fase 1: Código (sin tocar el servidor)

| Fix | Impacto | Esfuerzo |
|---|---|---|
| Rate limiting en Express | Cierra brute force del API_TOKEN | 30 min |
| Fix XSS en dashboard | Cierra robo de tokens via job title | 45 min |
| Reactivar CSP | Última línea de defensa contra XSS | 15 min |
| Puerto 3000 a localhost | Cierra acceso al dashboard desde la LAN | 5 min |
| Redis password obligatorio | Cierra acceso a la cola sin auth | 15 min |
| `/health` sin detalles | Cierra fingerprinting | 20 min |

### Fase 2: Servidor

| Fix | Impacto | Esfuerzo |
|---|---|---|
| SSH key-only | Cierra brute force SSH | 30 min |
| fail2ban | Detecta y bloquea ataques | 15 min |
| ufw (firewall) | Cierra todos los puertos excepto SSH | 15 min |

### Fase 3: Hardening

| Fix | Impacto | Esfuerzo |
|---|---|---|
| Usuario no-root para PM2 | Limita daño si hackean la app | 1h |
| Docker hardening | Sin root en container, no-new-privileges | 30 min |
| systemd credentials | Service role key en tmpfs, no en disco | 45 min |
| Validación MIME | Previene archivos maliciosos en SMB | 20 min |

---

## 12. Archivos clave

| Archivo | Función |
|---|---|
| `src/index.js` | Entry point, Express app, disk monitor |
| `src/config.js` | Validación de variables de entorno |
| `src/shutdown.js` | Cierre graceful, notificación de apagado |
| `src/banner.js` | Banner ASCII, notificación de inicio, detección de crash |
| `src/middleware/api-auth.js` | Bearer Token con timingSafeEqual |
| `src/middleware/error-handler.js` | Error handler centralizado |
| `src/services/downloader.js` | Lógica de descarga, idempotencia, locks |
| `src/services/supabase.js` | Cliente Supabase singleton |
| `src/jobs/bull-queue.js` | Cola BullMQ, worker, circuit breaker |
| `src/jobs/polling.js` | Polling, auto-heal, backpressure |
| `src/jobs/metrics-tracker.js` | Métricas de jobs, alertas Telegram |
| `src/utils/notify.js` | Telegram bot, plantillas corporativas |
| `src/utils/sanitize.js` | Sanitización, anti path traversal |
| `src/utils/lock.js` | Lock distribuido (memory/Redis) |
| `src/utils/disk.js` | Check de espacio en disco |
| `src/utils/logger.js` | Winston con rotación diaria |
| `ecosystem.config.js` | Configuración PM2 |
| `docker-compose.redis.yml` | Configuración Redis Docker |
| `.env` | Secrets (no en git, chmod 600) |
| `.env.example` | Plantilla de configuración |
