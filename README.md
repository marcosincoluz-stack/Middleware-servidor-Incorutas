[![CI](https://github.com/marcosincoluz-stack/Middleware-servidor-Incorutas/actions/workflows/ci.yml/badge.svg)](https://github.com/marcosincoluz-stack/Middleware-servidor-Incorutas/actions/workflows/ci.yml)
![Node.js](https://img.shields.io/badge/Node.js-22-339933?logo=nodedotjs&logoColor=white)
![Vitest](https://img.shields.io/badge/Tests-Vitest-6E9F18?logo=vitest&logoColor=white)
![License](https://img.shields.io/badge/License-Internal_Use-blue)

# Incorutas Photo Sync

Sincronización de evidencias fotográficas entre Supabase Storage y la infraestructura de almacenamiento local (SMB). Diseñado para operación continua en servidores on-premise sin exposición a internet.

---

## Arquitectura

```
Supabase (nube)
  │
  │  Polling cada 30s
  ▼
Middleware (Node.js + Express)
  │
  ├── BullMQ Worker (Redis) ── descarga fotos ──▶ SMB /mnt/trabajos
  ├── Dashboard web (puerto 3000)
  ├── Métricas Prometheus (/metrics)
  └── Alertas Telegram
```

El middleware consulta Supabase cada 30 segundos en busca de trabajos pendientes. No requiere webhooks, Edge Functions ni puertos abiertos hacia el exterior.

📐 **[Ver especificación de arquitectura completa →](ARCHITECTURE.md)**

---

## Despliegue

### Requisitos

- Node.js 18+
- Docker y Docker Compose
- Almacenamiento SMB montado en el servidor

### Instalación

```bash
git clone <repo> /opt/incorutas-photo-sync
cd /opt/incorutas-photo-sync
npm install
cp .env.example .env
# Editar .env con las credenciales reales
chmod 600 .env
```

### Docker (recomendado)

```bash
docker compose up -d
```

Levanta el middleware y Redis con un solo comando. El archivo `docker-compose.yml` incluye volúmenes para SMB, logs y datos persistentes.

### PM2 (alternativa)

```bash
docker compose -f docker-compose.redis.yml up -d
pm2 start ecosystem.config.js
pm2 save && pm2 startup
```

---

## Configuración

Todas las variables se definen en `.env`. Ver `.env.example` para la lista completa.

**Obligatorias:**

| Variable | Descripción |
|---|---|
| `SUPABASE_URL` | URL del proyecto Supabase |
| `SUPABASE_SERVICE_KEY` | Clave service_role (no se expone vía config.js) |
| `API_TOKEN` | Token Bearer para endpoints `/api/*` |
| `TRABAJOS_BASE_PATH` | Ruta del montaje SMB |

**Opcionales destacadas:**

| Variable | Default | Descripción |
|---|---|---|
| `POLLING_INTERVAL_MS` | `30000` | Intervalo de polling rápido a Supabase |
| `SLOW_POLLING_INTERVAL_MS` | `300000` | Intervalo de polling lento a Supabase |
| `ADAPTIVE_POLLING_ENABLED` | `true` | Activar/desactivar polling adaptativo fuera de horario laboral |
| `ADAPTIVE_IDLE_THRESHOLD` | `3` | Ciclos vacíos antes de comenzar backoff |
| `ADAPTIVE_MAX_INTERVAL_MS` | `1800000` | Intervalo máximo del backoff fuera de horario laboral (30 min) |
| `BUSINESS_HOURS_START` | `7` | Hora local de inicio de jornada laboral |
| `BUSINESS_HOURS_END` | `21` | Hora local de fin de jornada laboral |
| `BUSINESS_DAYS` | `1,2,3,4,5` | Días laborables (Lunes a Viernes) |
| `POLLING_ENABLED` | `true` | Activar/desactivar polling |
| `ENABLE_FOLDER_MOVE` | `false` | Mover carpetas a TERMINADOS al pagar |
| `REDIS_PASSWORD` | — | Contraseña de Redis (recomendado en producción) |
| `TELEGRAM_BOT_TOKEN` | — | Bot de alertas |
| `TELEGRAM_CHAT_ID` | — | Grupo de notificaciones |
| `ALLOWED_IMAGE_EXTENSIONS` | `jpg,jpeg,png,...` | Extensiones de imagen permitidas (sin punto, separadas por coma) |

---

## Comandos

```bash
npm start              # Producción
npm run dev            # Desarrollo (NODE_ENV=development)
npm test               # Tests (Vitest)
npm run test:coverage  # Tests con cobertura
npm run lint           # ESLint
npm run backfill       # Descarga retroactiva vía CLI
npm run backfill:dry   # Simulación de descarga retroactiva
```

---

## Endpoints

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| `GET` | `/health` | No | Estado del servicio (SMB, Redis, Supabase) |
| `GET` | `/metrics` | Sí | Métricas en formato Prometheus |
| `GET` | `/status` | Sí | Estado detallado de la cola |
| `GET` | `/api/dashboard` | Sí | Datos del dashboard |
| `GET` | `/api/logs` | Sí | Últimas líneas de log |
| `GET` | `/api/dlq` | Sí | Jobs fallidos (Dead-Letter Queue) |
| `GET` | `/api/pending-planos` | Sí | Jobs pendientes sin plano subido |
| `POST` | `/api/backfill` | Sí | Forzar descarga retroactiva |
| `POST` | `/api/retry-failed/:jobId` | Sí | Reintentar fotos fallidas de un job |
| `POST` | `/api/upload-plano/:jobId` | Sí | Subir manualmente el plano de un job |

Autenticación mediante cabecera `Authorization: Bearer <API_TOKEN>`.

---

## Seguridad

- `.env` con permisos `600` — el servidor advierte al arrancar si los permisos son abiertos.
- `SUPABASE_SERVICE_KEY` se lee directamente de `process.env`, nunca se exporta vía `config.js`.
- Comparación timing-safe para tokens API (`crypto.timingSafeEqual`).
- Sanitización de nombres de archivo y protección contra path traversal.
- Redis con `requirepass` en Docker Compose.
- `/health` expone solo información mínima. Detalles del sistema en `/status` (auth requerido).

---

## Robustez

- **Descargas atómicas**: escritura a `.part`, renombrado solo en éxito. Limpieza de huérfanos al arrancar.
- **Circuit breaker**: tras 5 fallos consecutivos de Supabase, el circuito se abre y los jobs fallan rápido.
- **Tolerancia a fallos parciales**: `DOWNLOAD_TOLERANCE_PERCENT` permite marcar jobs como completados con advertencias.
- **Backpressure**: `/backfill` devuelve 429 si la cola supera 200 jobs pendientes.
- **Graceful shutdown**: detiene polling, cierra conexiones HTTP, drena la cola, persiste métricas.
- **Disk check mid-loop**: re-verifica espacio cada 10 fotos durante la descarga.
- **Resolución de colisiones**: nombres duplicados reciben sufijo `(1)`, `(2)`, etc.

---

## Monitorización

### Prometheus

Configurar scrape en `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'incorutas-photo-sync'
    scrape_interval: 15s
    static_configs:
      - targets: ['localhost:3000']
    metrics_path: '/metrics'
    bearer_token: '<API_TOKEN>'
```

### Telegram

Alertas automáticas para: disco lleno, SMB desmontado, jobs fallidos, polling con fallos repetidos. Configurar `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID` en `.env`.

---

## Testing

```bash
npm test
```

Suite de tests con Vitest (conteo actualizado en `AGENTS.md`). Cobertura con `npm run test:coverage`. Pre-commit hook con ESLint vía husky + lint-staged.

---

## Estructura

```
src/
  index.js              Entry point
  config.js             Configuración y validaciones de arranque
  shutdown.js           Cierre graceful
  routes/               Endpoints HTTP
  services/             Lógica de descarga y movimiento de carpetas
  jobs/                 Cola BullMQ, polling, métricas, DLQ
  middleware/           Auth, error handler, request ID, logging
  utils/                Logger, disk, lock, notify, sanitize, etc
  validations/          Esquemas Zod
  public/               Dashboard web
scripts/
  backfill.js           CLI de descarga retroactiva
tests/
  unit/                 Tests unitarios
  integration/          Tests de integración
```

---

## Licencia

Uso interno — Incorutas.
