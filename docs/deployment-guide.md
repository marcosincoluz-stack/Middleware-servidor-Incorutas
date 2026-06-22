# Guía de Despliegue — incorutas-photo-sync en Ubuntu Server

Tutorial paso a paso basado en la experiencia real de despliegue. Incluye los problemas encontrados y sus soluciones.

---

## Prerrequisitos

| Requisito | Verificación | Mínimo |
|---|---|---|
| Node.js | `node --version` | v18+ (probado con v20.20.2) |
| Docker | `docker --version` | Cualquier versión reciente |
| Docker Compose v2 | `docker compose version` | v2+ |
| SMB montado | `ls /mnt/trabajos/` | Debe mostrar `1ACTIVOS/` y `TERMINADOS/` |
| Acceso SSH | — | Key-only recomendado |

---

## Paso 1: Instalar Docker y Docker Compose

Si Docker no está instalado:

```bash
sudo apt update
sudo apt install -y docker.io
sudo systemctl enable docker --now
```

Docker Compose v2 no viene incluido con `docker.io` en Ubuntu. Instalar por separado:

```bash
sudo apt install -y docker-compose-v2
```

Verificar:

```bash
docker --version
docker compose version
```

---

## Paso 2: Instalar dependencias del proyecto

```bash
cd /home/admin/incorutas-photo-sync
npm ci --omit=dev --ignore-scripts
```

> **Nota:** `--ignore-scripts` es necesario porque el `package.json` tiene un script `prepare` que ejecuta `husky` (una devDependency). Sin `--ignore-scripts`, `npm ci --omit=dev` falla con `sh: 1: husky: not found`.
>
> **Fix permanente pendiente:** Mover el script `prepare` fuera de `package.json` o condicionarlo a desarrollo.

---

## Paso 3: Generar tokens seguros

Generar 3 tokens aleatorios:

```bash
openssl rand -hex 32    # API_TOKEN
openssl rand -hex 32    # WEBHOOK_SECRET
openssl rand -hex 24    # REDIS_PASSWORD
```

Anotar los 3 valores. Se usarán en el siguiente paso.

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
| `WEBHOOK_SECRET` | Token generado en el paso 3 (**no existe en `.env.example`, hay que agregarlo manualmente**) |
| `API_TOKEN` | Token generado en el paso 3 |
| `REDIS_PASSWORD` | Token generado en el paso 3 |
| `TRABAJOS_BASE_PATH` | `/mnt/trabajos` (ruta del SMB montado) |

### Variables recomendadas para producción

```env
NODE_ENV=production
POLLING_ENABLED=true
ENABLE_FOLDER_MOVE=false
```

> `ENABLE_FOLDER_MOVE=false` inicialmente. Cambiar a `true` solo después de validar que las descargas funcionan correctamente.

### Guardar y salir de nano

- `Ctrl+O` → guarda
- `Enter` → confirma el nombre
- `Ctrl+X` → sale

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

> **Seguridad:** Solo el usuario del servicio puede leer el archivo. No usar root para correr el middleware si es posible.

---

## Paso 6: Arrancar Redis con Docker

```bash
docker compose -f docker-compose.redis.yml up -d
```

Verificar que está corriendo:

```bash
docker ps | grep redis
docker port incorutas-redis
sudo ss -tlnp | grep 6379
```

Debe mostrar el puerto mapeado: `6379/tcp -> 127.0.0.1:6379`.

### Problema: Puerto 6379 ocupado

Si hay un Redis nativo ya instalado (por ejemplo, desde `apt install redis-server`), el contenedor Docker no podrá bindar el puerto.

**Síntoma:**

```
Error response from daemon: failed to bind host port 127.0.0.1:6379/tcp: address already in use
```

**Diagnóstico:**

```bash
sudo lsof -i :6379
# o
sudo ss -tlnp | grep 6379
```

**Solución:** Parar y deshabilitar Redis nativo, luego reiniciar el contenedor:

```bash
sudo systemctl stop redis-server
sudo systemctl disable redis-server
docker compose -f docker-compose.redis.yml down
docker compose -f docker-compose.redis.yml up -d
```

### Problema: Contenedor sin puertos mapeados

Si el primer `docker compose up` falló (por conflicto de puerto), el contenedor puede quedar en estado inconsistente sin puertos mapeados aunque `docker ps` lo muestre como "Up".

**Síntoma:**

```bash
docker port incorutas-redis
# (sin output)
docker inspect incorutas-redis --format '{{json .NetworkSettings.Ports}}'
# {}
```

**Solución:** Recrear el contenedor desde cero:

```bash
docker compose -f docker-compose.redis.yml down
docker compose -f docker-compose.redis.yml up -d
```

---

## Paso 7: Instalar PM2

```bash
sudo npm install -g pm2
```

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

El estado debe ser `online`. Si aparece `errored`, ver la sección de problemas conocidos abajo.

---

## Paso 9: Configurar auto-inicio tras reboot

```bash
pm2 startup
```

PM2 imprime un comando que empieza con `sudo env PATH=...`. Copiarlo y ejecutarlo.

Después guardar la configuración actual:

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

Todos los campos deben estar en verde (`true` / `ok`).

---

## Acceso al dashboard

El dashboard no está expuesto al exterior. Para acceder desde tu PC:

```bash
ssh -L 3000:localhost:3000 admin@<ip-del-server>
```

Luego abrir `http://localhost:3000` en el navegador. Usar el `API_TOKEN` configurado en `.env` como contraseña de login.

La sesión SSH debe mantenerse abierta mientras se usa el dashboard.

---

## Bugs encontrados durante el despliegue y sus fixes

### Bug 1: WebSocket en Node.js 20

**Síntoma:**

```
Error: Node.js 20 detected without native WebSocket support.
Suggested solution: For Node.js < 22, install "ws" package and provide it via the transport option
```

**Causa:** El cliente de Supabase inicializa el módulo de realtime al crear la conexión, aunque el middleware use polling y no realtime. Node.js 20 no tiene WebSocket nativo (viene en Node 22+).

**Fix:**

1. Instalar el paquete `ws`:

```bash
npm install ws
```

2. Editar `src/services/supabase.js` y agregar `ws` como transport del cliente Supabase:

```js
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: {
    persistSession: false
  },
  realtime: {
    transport: ws,
    params: {
      eventsPerSecond: 0
    }
  }
});

module.exports = { supabase };
```

### Bug 2: Dependencia circular `addPhotosCount`

**Síntoma:**

```
Error: Cannot read properties of undefined (reading 'addPhotosCount')
```

El error aparece **después** de que cada job descarga exitosamente todas las fotos. Las fotos se guardan correctamente y el job se marca como descargado en Supabase, pero el job falla en BullMQ.

**Causa:** Dependencia circular entre `bull-queue.js` y `downloader.js`:

- `bull-queue.js` importa `downloader.js` (para `processJobApproved`)
- `downloader.js` importa `bull-queue.js` (para `jobQueue.addPhotosCount()`)

Node.js resuelve el ciclo dejando `jobQueue = undefined` en `downloader.js`.

**Fix:** En `src/services/downloader.js`, reemplazar el import circular por `metricsTracker` (que no crea ciclo):

Línea 9, cambiar:

```js
// Antes (crea dependencia circular)
const { jobQueue } = require('../jobs/bull-queue');

// Después (sin dependencia circular)
const { metricsTracker } = require('../jobs/metrics-tracker');
```

Líneas 394 y 399, cambiar:

```js
// Antes
jobQueue.addPhotosCount(downloadedCount);

// Después
metricsTracker.addPhotos(downloadedCount);
```

**Aplicar con sed en el servidor:**

```bash
cd /home/admin/incorutas-photo-sync
sed -i "s|const { jobQueue } = require('../jobs/bull-queue');|const { metricsTracker } = require('../jobs/metrics-tracker');|" src/services/downloader.js
sed -i 's|jobQueue\.addPhotosCount(downloadedCount)|metricsTracker.addPhotos(downloadedCount)|g' src/services/downloader.js
pm2 restart incorutas-photo-sync
```

### Bug 3: Jobs quedan en estado "failed" después del fix

**Síntoma:** Después de aplicar el fix del Bug 2, los jobs que fallaron antes quedan en estado "failed" en Redis. BullMQ no los reprocesa y el polling los salta con "ya existe en estado failed".

**Causa:** Comportamiento esperado de BullMQ. Los jobs en estado "failed" no se reprocesan automáticamente. Para eso existe la DLQ (Dead-Letter Queue) con endpoints manuales.

**Solución:** Limpiar la cola de Redis para que el polling re-enqueue los jobs frescos:

```bash
docker exec incorutas-redis redis-cli -a $(grep REDIS_PASSWORD .env | cut -d= -f2) FLUSHDB
pm2 restart incorutas-photo-sync
```

> **Seguro:** Los jobs ya descargados no se re-procesan porque el polling consulta `WHERE downloaded_at IS NULL` en Supabase. Solo se re-enqueue los jobs que no se habían descargado.

---

## Limpieza de cola de Redis (comando de referencia)

```bash
docker exec incorutas-redis redis-cli -a $(grep REDIS_PASSWORD .env | cut -d= -f2) FLUSHDB
```

Solo usar cuando sea necesario resetear la cola. No afecta los jobs ya descargados (la idempotencia se controla con `downloaded_at` en Supabase).

---

## Comandos de administración

| Acción | Comando |
|---|---|
| Ver estado | `pm2 status` |
| Ver logs en vivo | `pm2 logs incorutas-photo-sync` |
| Ver últimas N líneas | `pm2 logs incorutas-photo-sync --lines 50` |
| Reiniciar | `pm2 restart incorutas-photo-sync` |
| Detener | `pm2 stop incorutas-photo-sync` |
| Eliminar proceso | `pm2 delete incorutas-photo-sync` |
| Health check | `curl http://localhost:3000/health` |
| Estado Redis | `docker ps \| grep redis` |
| Logs Redis | `docker logs incorutas-redis --tail 20` |
| Reiniciar Redis | `docker compose -f docker-compose.redis.yml restart` |
| Limpiar cola | `docker exec incorutas-redis redis-cli -a <password> FLUSHDB` |

---

## Pendientes de endurecimiento

| Item | Prioridad | Descripción |
|---|---|---|
| Fix script `prepare`/`husky` | Media | Mover o condicionar el script `prepare` en `package.json` para que `npm ci --omit=dev` no falle sin `--ignore-scripts` |
| systemd credentials | Media | Reemplazar `.env` plano por `LoadCredential=` en systemd. Las claves van a tmpfs (`/run/credentials/`), no persisten en disco |
| Usuario no-root | Media | Correr el middleware como usuario dedicado, no como root |
| Firewall (ufw) | Baja | Limitar todo a localhost excepto SSH |
| Log rotation PM2 | Baja | Instalar `pm2-logrotate` para rotación automática de logs |
| TLS Redis | Baja | Si Redis y el middleware están en hosts diferentes, habilitar TLS en la conexión |

---

## Arquitectura de despliegue

```
Supabase (cloud)
  ↑
  | polling cada 30s (saliente, sin puertos abiertos)
  |
Ubuntu Server
  ├── Node.js middleware (PM2, puerto 3000 localhost)
  ├── Redis 7 (Docker, puerto 6379 localhost)
  └── /mnt/trabajos (SMB mount de SRV-2019)
       ├── 1ACTIVOS/
       │    ├── P260129 - .../FOTOS/FOTOS TERMINADO/*.jpg
       │    ├── P251910 - .../FOTOS/FOTOS TERMINADO/*.jpg
       │    └── ...
       └── TERMINADOS/
```

No se necesitan puertos abiertos al exterior. El middleware hace llamadas salientes a Supabase cada 30 segundos (polling). El dashboard se accede vía SSH tunnel.

---

## Flujo normal de operación

1. **Polling** consulta Supabase cada 30s por jobs aprobados (`WHERE downloaded_at IS NULL`)
2. Jobs encontrados se encolan en **BullMQ** (Redis)
3. **Worker** procesa jobs secuencialmente (concurrency: 1)
4. Cada job descarga fotos desde **Supabase Storage** a `/mnt/trabajos/1ACTIVOS/`
5. Job se marca como `downloaded_at` en Supabase (idempotencia)
6. Si un job falla, BullMQ reintenta automáticamente 3 veces con backoff exponencial
7. Si las 3 fallan, el job va a la **DLQ** para revisión manual
8. Métricas se persisten en `data/metrics.json` y se exponen en `/metrics` (formato Prometheus)
