# Guía de Despliegue — incorutas-photo-sync en Ubuntu Server

Tutorial paso a paso actualizado con todos los fixes de los Sprints 1-5. Sigue esta guía en orden y no tendrás que dar vueltas.

---

## Prerrequisitos

| Requisito | Verificación | Mínimo |
|---|---|---|
| Node.js | `node --version` | v18+ (probado con v20.20.2) |
| Docker | `docker --version` | Cualquier versión reciente |
| Docker Compose v2 | `docker compose version` | v2+ |
| SMB montado en `/mnt/trabajos` | `ls /mnt/trabajos/` | Debe mostrar `1ACTIVOS/` y `TERMINADOS/` |
| SMB en `/etc/fstab` con `nofail` | `grep trabajos /etc/fstab` | Auto-montaje tras reboot |
| Acceso SSH | — | Key-only recomendado |
| Repo clonado en `/home/admin/incorutas-photo-sync` | `ls /home/admin/incorutas-photo-sync/package.json` | — |

---

## Paso 1: Instalar Docker y Docker Compose

```bash
sudo apt update
sudo apt install -y docker.io
sudo systemctl enable docker --now
sudo apt install -y docker-compose-v2
```

Verificar:

```bash
docker --version
docker compose version
```

---

## Paso 2: Clonar el repo e instalar dependencias

```bash
cd /home/admin/incorutas-photo-sync
git pull origin main
npm ci --omit=dev
```

> El script `prepare` de `package.json` está fixeado (Sprint 1) — ya no necesita `--ignore-scripts`.

---

## Paso 3: Generar tokens seguros

```bash
openssl rand -hex 32    # API_TOKEN
openssl rand -hex 24    # REDIS_PASSWORD
```

Anotar los 2 valores.

---

## Paso 4: Configurar `.env`

```bash
cp .env.example .env
nano .env
```

### Variables obligatorias

| Variable | Valor |
|---|---|
| `SUPABASE_URL` | URL real del proyecto Supabase |
| `SUPABASE_SERVICE_KEY` | Service role key de Supabase |
| `API_TOKEN` | Token generado en el paso 3 |
| `REDIS_PASSWORD` | Token generado en el paso 3 |
| `TRABAJOS_BASE_PATH` | `/mnt/trabajos` (ruta del SMB montado) |

### Variables recomendadas para producción

```env
NODE_ENV=production
POLLING_ENABLED=true
ENABLE_FOLDER_MOVE=false
```

> `ENABLE_FOLDER_MOVE=false` inicialmente. Cambiar a `true` solo después de validar que las descargas funcionan.

> **Nota:** `WEBHOOK_SECRET` NO es necesaria. El middleware usa polling, no webhooks. Si la tienes en el `.env` de una versión anterior, puedes eliminarla.

### Guardar y salir de nano

`Ctrl+O` → `Enter` → `Ctrl+X`

---

## Paso 5: Proteger `.env`

```bash
chmod 600 .env
chown admin:admin .env
```

Verificar:

```bash
ls -la .env
```

Debe mostrar `-rw-------` con owner `admin:admin`.

---

## Paso 6: Arrancar Redis con Docker

```bash
docker compose -f docker-compose.redis.yml up -d
```

Verificar:

```bash
docker ps | grep redis
docker port incorutas-redis
sudo ss -tlnp | grep 6379
```

Debe mostrar: `6379/tcp -> 127.0.0.1:6379`.

### Problema: Puerto 6379 ocupado

Si hay un Redis nativo instalado (`apt install redis-server`):

```bash
sudo systemctl stop redis-server
sudo systemctl disable redis-server
docker compose -f docker-compose.redis.yml down
docker compose -f docker-compose.redis.yml up -d
```

### Problema: Contenedor sin puertos mapeados

Si el primer `docker compose up` falló, el contenedor puede quedar inconsistente:

```bash
docker compose -f docker-compose.redis.yml down
docker compose -f docker-compose.redis.yml up -d
```

---

## Paso 7: Instalar PM2 y pm2-logrotate

```bash
sudo npm install -g pm2
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
```

> `pm2-logrotate` rota los logs de PM2 automáticamente (Sprint 1). Sin esto, los logs crecen infinitamente.

---

## Paso 8: Arrancar el middleware

```bash
pm2 start ecosystem.config.js --env production
```

Verificar:

```bash
pm2 status
pm2 logs incorutas-photo-sync --lines 20
```

El estado debe ser `online`.

> **Nota sobre logs:** El `ecosystem.config.js` está configurado con `out_file: '/dev/null'` y `error_file: '/dev/null'` (Sprint 5). Los logs se gestionan exclusivamente vía Winston con rotación diaria en `logs/sync-YYYY-MM-DD.log`. Esto evita duplicación de logs entre PM2 y Winston.

---

## Paso 9: Configurar auto-inicio tras reboot

```bash
pm2 startup
```

PM2 imprime un comando (`sudo env PATH=...`). Copiarlo y ejecutarlo.

```bash
pm2 save
```

---

## Paso 10: Verificación final

```bash
curl http://localhost:3000/health
```

Respuesta esperada:

```json
{
  "status": "ok",
  "smb_mounted": true,
  "disk": { "freeMB": "...", "isSafe": true },
  "redis": true,
  "supabase": true,
  "version": "2.0.0"
}
```

---

## Paso 11: Verificar auto-arranque tras reboot

La cadena completa de auto-arranque es:

```
Servidor arranca
  → systemd inicia Docker (enable docker)
    → Docker inicia Redis (restart: unless-stopped)
  → systemd inicia PM2 (pm2-root.service)
    → PM2 restaura procesos (dump.pm2)
      → Middleware arranca y conecta a Redis
  → fstab monta SMB (nofail)
    → Middleware puede escribir en /mnt/trabajos
```

Verificar que el SMB está en fstab:

```bash
grep trabajos /etc/fstab
```

Debe mostrar una línea con `cifs` y `nofail`. Si no, el SMB no se auto-monta y el middleware no podrá escribir fotos tras un reboot.

---

## Acceso al dashboard

El dashboard no está expuesto al exterior. Acceder vía SSH tunnel:

```bash
ssh -L 3000:localhost:3000 admin@<ip-del-server>
```

Abrir `http://localhost:3000` en el navegador. Usar el `API_TOKEN` del `.env` como login.

La sesión SSH debe mantenerse abierta mientras se usa el dashboard.

---

## Arquitectura

```
Supabase (cloud)
  ↑
  | polling cada 30s (saliente, sin puertos abiertos)
  |
Ubuntu Server
  ├── Node.js middleware (PM2, puerto 3000 localhost)
  │    ├── Polling cada 30s → consulta Supabase
  │    ├── BullMQ Worker → procesa jobs secuencialmente
  │    ├── Auto-heal → re-descarga evidence con local_path IS NULL
  │    ├── Disk monitor → alerta Telegram si disco baja
  │    └── Dashboard → métricas, logs, DLQ, evidencias pendientes
  ├── Redis 7 (Docker, puerto 6379 localhost)
  └── /mnt/trabajos (SMB mount de SRV-2019, auto-montado via fstab)
       ├── 1ACTIVOS/
       │    └── PXXXXXX - .../FOTOS/FOTOS TERMINADO/*.jpg
       └── TERMINADOS/
```

Sin puertos abiertos al exterior. El middleware hace llamadas salientes a Supabase cada 30s.

---

## Flujo normal de operación

1. **Polling** consulta Supabase cada 30s por jobs aprobados (`status IN ('approved','paid') AND downloaded_at IS NULL`)
2. Jobs encontrados se encolan en **BullMQ** (Redis) con deduplicación por `jobId`
3. **Worker** procesa jobs secuencialmente (concurrency: 1, rate limit 1/1000ms)
4. **Lock distribuido** protege `processJobApproved` — dos instancias no pueden procesar el mismo job simultáneamente (Sprint 4)
5. Cada job descarga fotos **y actas** (`type IN ('photo','signature')`) desde Supabase Storage a `/mnt/trabajos/1ACTIVOS/`
6. Solo se descargan evidencias con `local_path IS NULL` (idempotencia a nivel foto — Sprint 2)
7. `local_path` se actualiza en Supabase por cada evidencia. Si la BD falla, el job **no** se marca como descargado (Sprint 2)
8. Job se marca como `downloaded_at` en Supabase solo si todas las evidencias se registraron correctamente
9. Si un job falla, BullMQ reintenta 3 veces con backoff exponencial (2s → 4s → 8s)
10. Si las 3 fallan, el job va a la **DLQ** para revisión manual
11. **Auto-heal** (`pollStaleJobs`) busca jobs descargados con evidence pendiente y la re-descarga automáticamente (Sprint 3)
12. **Disk monitor** revisa espacio cada 5 min y alerta por Telegram si está crítico o bajo (Sprint 4)
13. Métricas se persisten en `data/metrics.json` y se exponen en `/metrics` (formato Prometheus)

---

## Evidencias: fotos y actas

El middleware descarga **dos tipos** de evidencias:

| Type | Descripción | Carpeta destino |
|---|---|---|
| `photo` | Fotos de evidencia | `FOTOS/FOTOS TERMINADO/` |
| `signature` | Actas/firmas | `FOTOS/FOTOS TERMINADO/` (misma carpeta) |

El dashboard muestra "Evidencias Pendientes" con distinción entre fotos y actas (ej: "3 fotos, 1 acta").

---

## Comandos de administración

| Acción | Comando |
|---|---|
| Ver estado | `pm2 status` |
| Ver logs Winston | `pm2 logs incorutas-photo-sync --lines 50` |
| Ver logs filtrados | `pm2 logs incorutas-photo-sync --lines 200 --nostream \| grep -i "auto-heal\|polling\|error"` |
| Reiniciar | `pm2 restart incorutas-photo-sync` |
| Detener | `pm2 stop incorutas-photo-sync` |
| Eliminar y recrear | `pm2 delete incorutas-photo-sync && pm2 start ecosystem.config.js --env production` |
| Health check | `curl http://localhost:3000/health` |
| Estado Redis | `docker ps \| grep redis` |
| Logs Redis | `docker logs incorutas-redis --tail 20` |
| Reiniciar Redis | `docker compose -f docker-compose.redis.yml restart` |
| Limpiar cola Redis | `docker exec incorutas-redis redis-cli -a $(grep REDIS_PASSWORD .env \| cut -d= -f2) FLUSHDB` |
| Guardar PM2 | `pm2 save` |

> **Nota:** Al cambiar `ecosystem.config.js`, usar `pm2 delete` + `pm2 start` (no `restart`) para que PM2 relea la configuración.

---

## Actualizar el middleware a una nueva versión

```bash
cd /home/admin/incorutas-photo-sync
git pull origin main
npm ci --omit=dev
pm2 restart incorutas-photo-sync
```

Si cambiaron archivos de configuración (`ecosystem.config.js`, `docker-compose.redis.yml`):

```bash
pm2 delete incorutas-photo-sync
pm2 start ecosystem.config.js --env production
pm2 save
```

---

## Troubleshooting

### El middleware no descarga nada

1. Verificar health: `curl http://localhost:3000/health`
2. Verificar Redis: `docker ps | grep redis`
3. Verificar SMB: `ls /mnt/trabajos/1ACTIVOS/`
4. Verificar logs: `pm2 logs incorutas-photo-sync --lines 200 --nostream | grep -i "polling\|error"`
5. Si BullMQ tiene jobs en "failed": limpiar Redis con `FLUSHDB` y reiniciar

### El dashboard muestra "En sesión: undefined"

Esto era un bug ya fixeado (Sprint 1). Si aparece, el código del servidor está desactualizado:

```bash
cd /home/admin/incorutas-photo-sync
git pull origin main
pm2 restart incorutas-photo-sync
```

### Jobs aparecen como pendientes pero no se descargan

El auto-heal procesa jobs con `downloaded_at` set y evidence con `local_path IS NULL`. Si los jobs no tienen `downloaded_at`, el polling normal los maneja via BullMQ.

Verificar:

```bash
pm2 logs incorutas-photo-sync --lines 200 --nostream | grep -i "auto-heal\|polling"
```

### Fotos duplicadas en disco

Esto era un bug ya fixeado (Sprint 2 — idempotencia a nivel foto). Si aparece, el código está desactualizado. Actualizar con `git pull`.

### Redis no conecta

```bash
docker ps | grep redis
docker port incorutas-redis
sudo ss -tlnp | grep 6379
```

Si no hay puerto mapeado, recrear el contenedor:

```bash
docker compose -f docker-compose.redis.yml down
docker compose -f docker-compose.redis.yml up -d
```

### Puerto 6379 ocupado por Redis nativo

```bash
sudo systemctl stop redis-server
sudo systemctl disable redis-server
docker compose -f docker-compose.redis.yml down
docker compose -f docker-compose.redis.yml up -d
```

---

## Auto-arranque tras reboot

Todo está configurado para arrancar automáticamente tras un reboot o corte de luz:

| Componente | Mecanismo | Verificación |
|---|---|---|
| Docker | `systemctl enable docker` | `systemctl is-enabled docker` |
| Redis | `restart: unless-stopped` en Docker | `docker inspect incorutas-redis --format '{{.HostConfig.RestartPolicy.Name}}'` |
| PM2 | `pm2-root.service` (systemd) | `systemctl is-enabled pm2-root` |
| Middleware | `dump.pm2` restaurado por PM2 | `pm2 list` |
| SMB mount | `/etc/fstab` con `nofail` | `grep trabajos /etc/fstab` |

---

## Seguridad

| Medida | Estado | Notas |
|---|---|---|
| `.env` con `chmod 600` | ✅ Recomendado | Solo el usuario del servicio puede leerlo |
| Bearer Token en `/api/*` | ✅ | `crypto.timingSafeEqual` — anti timing attacks |
| Helmet (cabeceras HTTP) | ✅ | Activado por defecto |
| Rate limiter por IP | ✅ | En endpoints públicos |
| Sanitización de filenames | ✅ | Anti Path Traversal |
| Sin puertos abiertos | ✅ | Polling saliente, SSH tunnel para dashboard |
| `service_role` key | ⚠️ En `.env` plano | Solo accesible via `process.env` en `supabase.js` |

### Endurecimiento pendiente (no urgente)

| Item | Descripción |
|---|---|
| systemd credentials | Reemplazar `.env` por `LoadCredential=` — claves en tmpfs, no en disco |
| Usuario no-root | Correr el middleware como usuario dedicado |
| Firewall (ufw) | Limitar todo a localhost excepto SSH |
| TLS Redis | Si Redis y middleware están en hosts diferentes |

---

## Monitoreo

### Prometheus

`GET /metrics` expone métricas en formato Prometheus text (sin autenticación, para scrapeo):

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'incorutas-photo-sync'
    scrape_interval: 15s
    static_configs:
      - targets: ['localhost:3000']
    metrics_path: '/metrics'
```

### Alertas Telegram (opcional)

Configurar `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID` en `.env` para recibir:

- **Disco crítico** — cuando el espacio es menor a `MIN_DISK_MB`
- **Disco bajo** — cuando el espacio es menor a 2x `MIN_DISK_MB` (aviso temprano)
- **Job fallido** — cuando un job agota todos los reintentos
- **Polling fallido** — cuando el polling falla 3 veces consecutivas
- **SMB desmontado** — cuando no se puede acceder a la ruta base

> El disk monitor revisa cada 5 minutos (Sprint 4) y envía alertas con cooldown de 10 minutos para no spamear.

---

## Cambios aplicados (Sprints 1-5)

### Sprint 1: Quick wins
- Fix script `prepare`/`husky` — `npm ci --omit=dev` ya no necesita `--ignore-scripts`
- Eliminado `WEBHOOK_SECRET` de la documentación (no se usa con polling)
- Instalación de `pm2-logrotate`

### Sprint 2: Race condition + dashboard
- Eliminado `processJobApproved` directo de `pollStaleJobs` — solo `retryFailedEvidences` para jobs con `downloaded_at`
- `pollStaleJobs` actualiza métricas (`metricsTracker.addPhotos`)
- Fix `dashboardFetchInProgress` stuck con `try/finally`
- Idempotencia a nivel foto — no descarga fotos que ya tienen `local_path` set
- `updateEvidenceLocalPath` retorna `true/false` en lugar de tragar errores
- Jobs no se marcan como `downloaded_at` si hay fallos de BD

### Sprint 3: Auto-heal reliability
- `pollStaleJobs` consulta jobs primero (con filtro de status), luego evidence de esos jobs
- Evita que evidence huérfana de jobs rejected/cancelled llene el LIMIT y ciegue el auto-heal

### Sprint 4: Monitoring & hardening
- Monitor de disco proactivo cada 5 min con alerta Telegram
- Alerta temprana de disco (2x threshold)
- Lock distribuido en `processJobApproved` — previene procesamiento duplicado
- Logging en catch blocks silenciados
- Disk check timeout no cuenta como `errorCount`

### Sprint 5: Cleanup
- Cleanup periódico de Maps en lock providers
- PM2 logs a `/dev/null` — Winston gestiona todos los logs con rotación diaria
- Tests para `pollStaleJobs` (4 tests nuevos, total 231)
