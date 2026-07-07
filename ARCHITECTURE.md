# Especificación de Arquitectura de Software

Este documento proporciona una descripción detallada de la arquitectura técnica, los flujos de datos, los mecanismos de tolerancia a fallos y los patrones de diseño utilizados en el middleware **Incorutas Photo Sync**.

---

## 1. Vista General de Componentes

El sistema está diseñado bajo un modelo de arquitectura desacoplada orientada a tareas mediante colas, separando la interfaz de monitorización/API y el ciclo de polling del worker de ejecución pesado.

```mermaid
graph TB
    subgraph Supabase [Nube Supabase]
        DB[(PostgreSQL)]
        EvidencesBucket[Bucket 'evidence']
        PlanosBucket[Bucket 'mounting-orders']
    end

    subgraph Local [Servidor Físico On-Premise]
        subgraph App [Middleware Node.js]
            Express[Express.js App]
            Polling[Polling Engine]
            Worker[BullMQ Worker]
        end

        subgraph Storage [Cola y Caché]
            Redis[(Redis)]
        end

        subgraph SMB [Almacenamiento Local SMB]
            Activos["1ACTIVOS/ (Trabajos Activos)"]
            Terminados["TERMINADOS/ (Trabajos Finalizados)"]
            Fabricacion["FABRICACION/ (Planos PDF)"]
        end
    end

    subgraph External [Notificaciones]
        Telegram[Telegram Bot API]
    end

    %% Relaciones
    Polling -- 1. Polling cada 30s --> DB
    Polling -- 2. Encolar Trabajo --> Redis
    Worker -- 3. Consumir Tarea --> Redis
    Worker -- 4. Descargar Evidencia --> EvidencesBucket
    Worker -- 5. Guardar Foto --> Activos
    Worker -- 6. Escanear Planos --> Fabricacion
    Worker -- 7. Subir Planos --> PlanosBucket
    Worker -- 8. Actualizar DB (RPC) --> DB
    Express -- Consultar Estado --> Redis
    Express -- Métricas /metrics --> Prometheus((Prometheus))
    Worker -. Alertas de Error .-> Telegram
    Polling -. Alertas de Error .-> Telegram
```

---

## 2. Flujo de Descarga de Fotos (`job.approved`)

Este flujo representa el ciclo completo de descarga de evidencias desde Supabase Storage hacia el montaje físico SMB en local.

```mermaid
sequenceDiagram
    autonumber
    participant DB as Supabase DB
    participant Poll as Polling Engine
    participant Q as Redis (BullMQ)
    participant W as Worker
    participant Disk as Almacenamiento SMB
    participant St as Supabase Storage

    Poll->>DB: Consultar jobs (status in [approved, paid], downloaded_at IS NULL)
    DB-->>Poll: Retornar lista de jobs candidatos
    Note over Poll: Verificar Backpressure<br/>(Pendientes en cola < BACKFILL_MAX_PENDING)
    Poll->>Q: Encolar job.approved (deduplicación por ID)
    
    Q->>W: Procesar tarea (limite: 1 job/s)
    Note over W: Circuit Breaker: cerrado (CLOSED)
    W->>DB: Re-verificar downloaded_at (Idempotencia)
    DB-->>W: Confirmar estado actual
    W->>Disk: checkDiskSpace() - Verificar espacio mínimo (MIN_DISK_MB)
    W->>DB: Consultar evidencias (type in [photo, signature], local_path IS NULL)
    DB-->>W: Retornar lista de evidencias del job
    
    W->>Disk: resolveProjectPhotosFolder() - Buscar o crear carpeta Pxxxxx (con Lock)
    
    loop Por cada Evidencia
        Note over W: Disk Check cada 10 fotos
        W->>St: Descargar buffer de imagen
        St-->>W: Retornar buffer
        Note over W: validateFileContent() - Verificar magic bytes e integridad
        W->>Disk: Escribir a archivo temporal (.part)
        W->>Disk: Renombrar temporal (.part -> final)
        W->>DB: updateEvidenceLocalPath(id, path)
    end

    alt Cero errores
        W->>DB: markJobAsDownloaded(jobId)
    else Errores dentro de tolerancia (DOWNLOAD_TOLERANCE_PERCENT)
        W->>DB: markJobAsDownloaded(jobId) con warnings
    else Excede tolerancia
        Note over W: Lanzar excepción (Error)
        W->>Q: Re-intentar tarea con Backoff Exponencial
    end
```

---

## 3. Flujo de Subida de Planos (`job.plano`)

Este proceso detecta de manera autónoma los PDFs de fabricación locales en el servidor físico y los sube a Supabase Storage para que el cliente pueda visualizarlos en tiempo real.

```mermaid
sequenceDiagram
    autonumber
    participant DB as Supabase DB
    participant Poll as Polling Engine
    participant Q as Redis (BullMQ)
    participant W as Worker
    participant Disk as Almacenamiento SMB (FABRICACION)
    participant St as Supabase Storage (mounting-orders)

    Poll->>DB: Consultar jobs (status in PLANO_UPLOAD_STATUSES)
    DB-->>Poll: Retornar lista de jobs candidatos
    Poll->>Q: Encolar job.plano
    
    Q->>W: Procesar tarea
    W->>DB: Consultar plans_url actuales del job
    DB-->>W: Retornar planes registrados en BD (JSON)
    W->>Disk: resolveFabricacionFolder() - Obtener ruta de la carpeta
    W->>Disk: listMatchingPdfs() - Buscar PDFs con prefijo Pxxxxx (DFS con Poda)
    Note over W: Comparar locales vs BD (Diff por nombre)<br/>Filtrar los no subidos aún
    
    alt Hay nuevos PDFs
        Note over W: selectPlanoPdfs() - Validar límite (PLANO_MAX_PLANOS_PER_JOB)
        loop Por cada PDF nuevo seleccionado
            W->>Disk: Leer archivo PDF en memoria
            Note over W: validatePdfBuffer() - Validar estructura (%PDF- / %%EOF)
            W->>St: uploadPlanoToStorage() (upsert: true)
            W->>St: exists() - Confirmar persistencia en bucket
            W->>DB: supabase.rpc('append_plano', { jobId, name, path }) (Atómico)
        end
    end
    Note over W: Actualizar métricas y liberar lock
```

---

## 4. Estado de Transición del Circuit Breaker

Para evitar la degradación del middleware por fallos repetitivos en las peticiones a la API externa de Supabase (por ejemplo, por cortes de internet), se utiliza un Circuit Breaker.

```mermaid
stateDiagram-v2
    [*] --> CLOSED : Inicialización

    state CLOSED {
        [*] --> Executing : Ejecutar llamada
        Executing --> Success : Éxito de la operación
        Success --> Executing : failureCount = 0
        Executing --> Failure : Fallo de la operación
        Failure --> Executing : failureCount < failureThreshold (5)
    }

    CLOSED --> OPEN : failureCount >= failureThreshold (5)
    Note right of OPEN : Falla inmediatamente sin llamar a la red.<br/>Evita desperdiciar hilos y reintentos.

    state OPEN {
        [*] --> CoolDown : Esperar resetTimeoutMs (30s)
    }

    OPEN --> HALF_OPEN : Timeout expirado

    state HALF_OPEN {
        [*] --> SingleTest : Permitir UNA llamada de prueba
        SingleTest --> TestSuccess : Éxito de la prueba
        SingleTest --> TestFailure : Fallo de la prueba
    }

    HALF_OPEN --> CLOSED : TestSuccess (Re-conectar)
    HALF_OPEN --> OPEN : TestFailure (Re-abrir circuito y resetear timeout)
```

---

## 5. Matriz de Clasificación de Errores

El componente `error-classifier` interpreta los errores lanzados durante la ejecución de las colas y determina dinámicamente si se debe reintentar, alertar de inmediato a los administradores o enviar el trabajo a la Dead-Letter Queue (DLQ).

```mermaid
graph TD
    Error[Error Capturado en Worker] --> Classify{Clasificar Error}
    
    Classify -- "Código nativo (ENOSPC)<br/>o contiene 'espacio en disco'" --> DiskFull[disk_full]
    Classify -- "Códigos (EACCES, ENOTDIR, EIO)<br/>o rutas base de red" --> SMBDisconnected[smb_disconnected]
    Classify -- "Códigos de red (ECONNRESET, ETIMEDOUT, EPIPE)" --> NetworkErr[network]
    Classify -- "Códigos de lock (EBUSY, ELOCKED)" --> LockErr[file_lock]
    Classify -- "Resto de excepciones" --> Unknown[unknown]

    %% Acciones
    DiskFull --> AlertDisk[alert_disk]
    SMBDisconnected --> AlertSMB[alert_smb]
    NetworkErr --> Retry[retry]
    LockErr --> Retry
    Unknown --> DLQ[none / Dead-Letter Queue]

    %% Destinos finales
    AlertDisk --> Telegram[Alerta Telegram Urgente]
    AlertSMB --> Telegram
    Retry --> BullRetry[Reintento en BullMQ con Backoff]
    DLQ --> BullFail[Job fallido en Redis]
```

---

## 6. Pipeline y Ciclo de Vida de la Cola BullMQ

La cola distribuida en Redis organiza los ciclos de ejecución, garantizando la persistencia e idempotencia del middleware frente a reinicios bruscos de servidor.

```mermaid
stateDiagram-v2
    [*] --> Wait : jobQueue.enqueue()
    Note right of Wait : Deduplicación por bullJobId.<br/>Evita encolar dos veces la misma tarea.

    Wait --> Active : Worker obtiene tarea (limiter activo)
    
    state Active {
        [*] --> Executing : Ejecutar lógica de negocio
    }

    Active --> Completed : Éxito
    Note right of Completed : Se mantiene en registro histórico<br/>(removeOnComplete.maxCount = 100)

    Active --> Failed : Excepción lanzada (attemptsMade < maxRetries)
    Active --> Delayed : attemptsMade < maxRetries
    Delayed --> Wait : Timeout expira (Backoff exponencial)

    Active --> DLQ : attemptsMade == maxRetries (3)
    state DLQ {
        [*] --> FailedList : Registro en cola de fallidos
    }

    FailedList --> RetryAPI : POST /api/retry-failed/:jobId
    RetryAPI --> Wait : Mover de vuelta a la cola activa

    FailedList --> ClearAPI : DELETE /api/dlq
    ClearAPI --> [*] : Eliminación física de Redis
```
