# ASTERION ONE — Documentación de Uso Completa

**Versión:** Fases 0–3 | **Última actualización:** 2026-03-20
**Proyecto:** Simulación de Flight Software y Ground Segment para misiones LEO

---

## NOTAS DE ENTORNO (Windows)

> Las instrucciones de esta guía asumen Git Bash en Windows.
> Diferencias clave respecto al README original:

| Elemento | Linux / macOS | Windows (este entorno) |
|----------|--------------|----------------------|
| Comando Python | `python3` | `python` |
| Activar venv | `source .venv/bin/activate` | `source .venv/Scripts/activate` |
| Puerto PostgreSQL | `5432` | `5433` (PG17 local ocupa 5432) |
| `npm ci` | Funciona | Usar `npm install` (no hay `package-lock.json`) |
| `npm test` (ground) | Funciona | Usar comando largo (ver §3.3) |

---

## 1. ARRANQUE RÁPIDO

### 1.1. Prerrequisitos

```bash
node --version     # v20+
python --version   # Python 3.11+
docker --version   # Docker 27+
docker compose version
```

### 1.2. Primera vez: instalar dependencias

```bash
# Desde la raíz del proyecto
python -m venv .venv

# Activar virtualenv:
source .venv/Scripts/activate       # Windows (Git Bash)
# source .venv/bin/activate         # macOS / Linux

# Deps Python (flight + twin)
pip install -r flight/requirements.txt
pip install -r twin/requirements.txt
# NOTA: numpy==1.26.4 no tiene wheel para Python 3.13.
#       Se instala automáticamente numpy 2.x (compatible).

# Deps Node.js
cd ground && npm install && cd ..
cd ground/ui && npm install && cd ../..
```

### 1.3. Levantar infraestructura (PostgreSQL)

```bash
# Arrancar Docker Desktop manualmente si no está corriendo, luego:
docker compose up -d

# Esperar ~5s a que el healthcheck pase, luego migrar:
cd ground
POSTGRES_PORT=5433 npx knex migrate:latest --knexfile knexfile.js         # DB dev
POSTGRES_PORT=5433 NODE_ENV=test npx knex migrate:latest --knexfile knexfile.js  # DB test
cd ..
```

> **Primera vez:** Si la DB `asterion_test` no existe, créala manualmente:
> ```bash
> docker exec asterion-postgres psql -U asterion -c "CREATE DATABASE asterion_test OWNER asterion"
> ```

### 1.4. Arrancar los servicios (3 terminales)

```bash
# ── Terminal 1 — Ground API + WebSocket Gateway (puertos 3000 y 8081) ──────────
cd ground
POSTGRES_PORT=5433 node src/index.js
# Salida esperada:
# [ws_gateway] WebSocket server listening on port 8081
# [api_server] Asterion Ground API listening on port 3000

# ── Terminal 2 — React UI (puerto 5173) ────────────────────────────────────────
cd ground/ui
npm run dev
# → http://localhost:5173

# ── Terminal 3 — Flight Software (Python) ──────────────────────────────────────
source .venv/Scripts/activate
python -m flight
# FSW se conecta al gateway en ws://localhost:8081/flight
# y empieza a enviar telemetría cada segundo
```

### 1.5. Abrir el dashboard

```
http://localhost:5173
```

El sidebar mostrará 3 indicadores verdes: **Ground WS ●**, **Flight Link ●**, **Database ●**
Si Flight Link está en ámbar, el FSW aún no se ha conectado al gateway.

---

## 2. FLIGHT SEGMENT (Python)

### 2.1. Flight Software Core

```bash
source .venv/Scripts/activate
cd flight

# Ejecutar el FSW (main loop)
python fsw_core.py

# Arrancar en modo recovery (post-watchdog restart)
RECOVERY_MODE=SAFE python fsw_core.py

# Variables de entorno disponibles:
#   RECOVERY_MODE=SAFE       → Arranca en SAFE en vez de BOOT
#   WS_HOST=192.168.1.100   → Host del Ground WebSocket gateway
#   WS_PORT=8081             → Puerto del Ground WebSocket gateway
#   TELEM_FREQ_HZ=1          → Frecuencia de telemetría (Hz)
#   BOOT_COUNTER_FILE=...    → Ruta del fichero de boot counter
```

### 2.2. Sensor Simulator

```bash
source .venv/Scripts/activate
python -c "
from flight.sensor_sim import SensorSimulator
sim = SensorSimulator()
data = sim.read_all()
for subsystem, metrics in data.items():
    print(f'{subsystem}: {metrics}')
"

# Override mode (para fault injection manual):
python -c "
from flight.sensor_sim import SensorSimulator
sim = SensorSimulator()
sim.set_override('THERMAL', {'cpu_temp_c': 85.0})
print(sim.read_subsystem('THERMAL'))
sim.clear_override('THERMAL')
"
```

### 2.3. Audit Logger

```bash
source .venv/Scripts/activate
python -c "
from flight.audit_logger import AuditLogger
logger = AuditLogger('/tmp/audit_test.jsonl')
logger.log('TEST', severity='INFO', metadata={'x': 1})
result = logger.verify_chain()
print(f'Chain valid: {result}')
"
```

### 2.4. Crypto Verifier

```bash
source .venv/Scripts/activate
python -c "
from flight.crypto_verifier import CryptoVerifier
verifier = CryptoVerifier()
print('Trusted keys:', len(verifier.get_trusted_keys()))
"
```

### 2.5. Disk Queue (Store-and-Forward)

```bash
source .venv/Scripts/activate
python -c "
from flight.disk_queue import DiskQueue
queue = DiskQueue('/tmp/test_queue')
print(f'Queue depth: {queue.depth()}')
print(f'Is empty: {queue.is_empty()}')
"
```

---

## 3. TESTS (TODOS)

### 3.1. Tests Python — Flight (150 tests)

```bash
source .venv/Scripts/activate

# Todos los tests de Flight
python -m pytest flight/ -v

# Tests por componente:
python -m pytest flight/tests/test_models.py -v              # 6 tests
python -m pytest flight/tests/test_sensor_sim.py -v          # 26 tests
python -m pytest flight/tests/test_audit_logger.py -v        # 17 tests
python -m pytest flight/tests/test_disk_queue.py -v          # 15 tests
python -m pytest flight/tests/test_crypto_verifier.py -v     # 12 tests
python -m pytest flight/tests/test_cmd_executor.py -v        # 14 tests
python -m pytest flight/tests/test_fsw_core.py -v            # 21 tests
python -m pytest flight/tests/test_window_scheduler.py -v    # 17 tests
python -m pytest flight/tests/test_comms_client.py -v        # 13 tests
python -m pytest flight/tests/test_integration_comms.py -v   # 9 tests

# Solo tests unitarios (sin integración)
python -m pytest flight/ -v -k "not integration"
```

### 3.2. Tests Python — Twin (2 tests)

```bash
source .venv/Scripts/activate
python -m pytest twin/ -v
```

### 3.3. Tests Node.js — Ground (152 tests)

```bash
cd ground

# TODOS los tests Ground (requiere PostgreSQL en :5433)
POSTGRES_PORT=5433 NODE_OPTIONS='--experimental-vm-modules' npx jest --forceExit --detectOpenHandles

# NOTA: `npm test` NO funciona en Windows porque el script en package.json usa
#        `NODE_OPTIONS='...'` sintaxis Unix. Usar el comando largo de arriba.

# Por componente:
POSTGRES_PORT=5433 NODE_OPTIONS='--experimental-vm-modules' npx jest src/db/__tests__/manager.test.js --forceExit
POSTGRES_PORT=5433 NODE_OPTIONS='--experimental-vm-modules' npx jest src/api/__tests__/server.test.js --forceExit
POSTGRES_PORT=5433 NODE_OPTIONS='--experimental-vm-modules' npx jest src/ws/__tests__/gateway.test.js --forceExit
POSTGRES_PORT=5433 NODE_OPTIONS='--experimental-vm-modules' npx jest src/services/__tests__/audit.test.js --forceExit
POSTGRES_PORT=5433 NODE_OPTIONS='--experimental-vm-modules' npx jest src/api/__tests__/bad_signature.test.js --forceExit

cd ..
```

### 3.4. Tests Crypto (Browser-side Ed25519)

```bash
# Canonical JSON — zero deps, sin Docker
node ground/ui/src/lib/__tests__/canonical_json.test.mjs     # 17 tests

# Python cross-compatibility
source .venv/Scripts/activate
python infra/verify_canonical_json.py                         # 7 checks

# Full Ed25519 pipeline (requiere deps en ground/ui)
cd ground/ui && node src/lib/__tests__/crypto.test.mjs && cd ../..   # 14 tests
```

### 3.5. Ejecutar TODO de una vez

```bash
source .venv/Scripts/activate

echo "=== Python Tests ==="
python -m pytest flight/ twin/ -v

echo "=== Ground Node Tests ==="
cd ground
POSTGRES_PORT=5433 NODE_OPTIONS='--experimental-vm-modules' npx jest --forceExit --detectOpenHandles
cd ..

echo "=== Crypto Tests ==="
node ground/ui/src/lib/__tests__/canonical_json.test.mjs
python infra/verify_canonical_json.py
cd ground/ui && node src/lib/__tests__/crypto.test.mjs && cd ../..

echo "=== ALL PASS ==="
```

### 3.6. Resumen de cobertura actual

| Suite | Tests | Estado |
|-------|-------|--------|
| Python Flight | 150 | PASS |
| Python Twin | 2 | PASS |
| Node Ground API | 38 | PASS |
| Node Ground DB | 54 | PASS |
| Node Ground WS | 19 | PASS |
| Node Ground Audit | 29 | PASS |
| Node Ground Bad-sig | 4 | PASS |
| Node Ground Smoke | 8 | PASS |
| JS Canonical JSON | 17 | PASS |
| Python Canonical JSON | 7 | PASS |
| JS Crypto Ed25519 | 14 | PASS |
| **TOTAL** | **342** | **ALL PASS** |

---

## 4. FAULT INJECTION (Testing/Demo)

### 4.1. Comandos disponibles

```bash
source .venv/Scripts/activate

# Ver todos los comandos
python infra/fault_injector.py --help

# Kill-process: mata el FSW y mide recovery time
# [REQ-FSW-WD-03s] Target: ≤ 3000ms
python infra/fault_injector.py inject kill-process

# Thermal spike: fuerza temperatura alta → T3 (NOMINAL→SAFE)
# [REQ-FSW-STATE-01]
python infra/fault_injector.py inject thermal-spike --temp 85 --duration 60

# Power drop: fuerza voltaje bajo → T3
python infra/fault_injector.py inject power-drop --voltage 4.2

# Network outage: fuerza blackout de comunicaciones
# [REQ-COM-ZERO-LOSS] Verifica 0 mensajes perdidos
python infra/fault_injector.py inject network-outage --duration 120

# Cascade failure: 3x kill consecutivos → T6 (SAFE→CRITICAL)
# [REQ-FSW-STATE-01]
python infra/fault_injector.py inject cascade-failure
```

### 4.2. Bad Signature Injection (Fase 3)

```bash
source .venv/Scripts/activate

# Envía plan con firma corrupta al Flight via Ground API
# [REQ-SEC-ED25519] Verifica: REJECTED, 0 executed, eventos CRITICAL
python infra/fault_injector_bad_sig.py

# Con API en otro host
python infra/fault_injector_bad_sig.py --api-base http://192.168.1.100:3000/api

# Solo JSON output
python infra/fault_injector_bad_sig.py --quiet
```

### 4.3. Output de fault injection

```json
{
  "injection_type": "kill-process",
  "injected_at": "2026-03-10T14:00:00.000Z",
  "recovered_at": "2026-03-10T14:00:02.950Z",
  "recovery_time_ms": 2950,
  "target_ms": 3000,
  "pass": true
}
```

---

## 5. GROUND SEGMENT — REST API

### 5.1. Base URL

```
http://localhost:3000/api
```

### 5.2. Contact Windows [REQ-GND-PLAN]

```bash
# Listar ventanas de contacto
curl http://localhost:3000/api/contact-windows

# Filtrar por estado
curl "http://localhost:3000/api/contact-windows?status=SCHEDULED"

# Crear ventana
curl -X POST http://localhost:3000/api/contact-windows \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Pass-017",
    "aos_time": "2026-03-20T14:00:00Z",
    "los_time": "2026-03-20T14:10:00Z"
  }'

# Activar ventana
curl -X PATCH http://localhost:3000/api/contact-windows/{ID} \
  -H "Content-Type: application/json" \
  -d '{"status": "ACTIVE"}'

# Cancelar ventana
curl -X PATCH http://localhost:3000/api/contact-windows/{ID} \
  -H "Content-Type: application/json" \
  -d '{"status": "CANCELLED"}'
```

### 5.3. Command Plans [REQ-SEC-ED25519]

```bash
# Crear plan de comandos (DRAFT)
curl -X POST http://localhost:3000/api/command-plans \
  -H "Content-Type: application/json" \
  -d '{
    "contact_window_id": "UUID_VENTANA",
    "operator_name": "hugo.cecilia",
    "commands": [
      {"command_type": "SET_PARAM", "payload": {"param_name": "gain", "param_value": 3.5}},
      {"command_type": "RUN_DIAGNOSTIC", "payload": {"subsystem": "THERMAL"}}
    ]
  }'

# Firmar plan (DRAFT → SIGNED)
curl -X PATCH http://localhost:3000/api/command-plans/{ID} \
  -H "Content-Type: application/json" \
  -d '{
    "signature": "BASE64_ED25519_SIGNATURE",
    "signature_algo": "Ed25519",
    "public_key": "BASE64_PUBLIC_KEY"
  }'

# Subir plan al Flight (SIGNED → UPLOADED)
# Precondiciones: plan SIGNED + Flight conectado (503) + ventana ACTIVE (409)
curl -X POST http://localhost:3000/api/command-plans/{ID}/upload \
  -H "Content-Type: application/json" \
  -d '{"public_key": "BASE64_PUBLIC_KEY"}'

# Ver plan con sus comandos
curl http://localhost:3000/api/command-plans/{ID}

# Listar planes
curl http://localhost:3000/api/command-plans
curl "http://localhost:3000/api/command-plans?status=COMPLETED"
```

**Errores del endpoint `/upload`:**

| Código | Error | Causa |
|--------|-------|-------|
| 409 | `NOT_SIGNED` | Plan en estado DRAFT |
| 503 | `FLIGHT_DISCONNECTED` | Flight no conectado via WebSocket |
| 409 | `WINDOW_NOT_ACTIVE` | Ventana de contacto no ACTIVE |

### 5.4. Commands [REQ-COM-ZERO-LOSS]

```bash
# Listar comandos
curl http://localhost:3000/api/commands

# Filtrar por plan
curl "http://localhost:3000/api/commands?plan_id=UUID"

# Filtrar por estado
curl "http://localhost:3000/api/commands?status=EXECUTED"
```

### 5.5. Telemetry [REQ-COM-ZERO-LOSS]

```bash
# Query telemetría
curl http://localhost:3000/api/telemetry

# Filtrar por subsistema
curl "http://localhost:3000/api/telemetry?subsystem=THERMAL"

# Múltiples subsistemas
curl "http://localhost:3000/api/telemetry?subsystem=THERMAL,POWER"

# Rango temporal
curl "http://localhost:3000/api/telemetry?from=2026-03-20T14:00:00Z&to=2026-03-20T14:10:00Z"

# Últimos N minutos
curl "http://localhost:3000/api/telemetry?last=30m"

# Último frame por subsistema
curl http://localhost:3000/api/telemetry/latest
```

### 5.6. Audit Events [REQ-FSW-LOG-SECURE]

```bash
# Listar eventos
curl http://localhost:3000/api/events

# Filtrar
curl "http://localhost:3000/api/events?source=FLIGHT"
curl "http://localhost:3000/api/events?severity=CRITICAL"
curl "http://localhost:3000/api/events?event_type=STATE_TRANSITION"
curl "http://localhost:3000/api/events?source=FLIGHT&severity=CRITICAL&limit=50"

# Verificar integridad de la cadena de hashes
curl http://localhost:3000/api/events/verify
# Respuesta: {"data": {"chain_valid": true, "total_events": 1247, "break_at_index": null}}
```

**Catálogo de event_type (Art.2 §3.5):**

| Event Type | Source | Severity |
|-----------|--------|----------|
| `PLAN_CREATED` | GROUND | INFO |
| `PLAN_SIGNED` | GROUND | INFO |
| `PLAN_UPLOADED` | GROUND | INFO |
| `WINDOW_CREATED` | GROUND | INFO |
| `OUTAGE_START` | SCHEDULER | INFO |
| `OUTAGE_END` | SCHEDULER | INFO |
| `TWIN_ALERT` | TWIN | WARNING |
| `TELEMETRY_GAP` | GROUND | WARNING |
| `STATE_TRANSITION` | FLIGHT | INFO |
| `COMMAND_EXECUTED` | FLIGHT | INFO |
| `COMMAND_REJECTED` | FLIGHT | CRITICAL |

### 5.7. Twin Forecasts [REQ-DT-EARLY-15m, REQ-DT-RATIONALE]

```bash
# Listar forecasts
curl http://localhost:3000/api/twin/forecasts

# Solo breaches
curl "http://localhost:3000/api/twin/forecasts?breach_only=true"

# Filtrar por modelo
curl "http://localhost:3000/api/twin/forecasts?model_type=THERMAL"

# Alertas activas
curl http://localhost:3000/api/twin/alerts

# Enviar forecast (usado por twin_api)
curl -X POST http://localhost:3000/api/twin/forecasts \
  -H "Content-Type: application/json" \
  -d '{
    "model_type": "THERMAL",
    "horizon_min": 30,
    "predicted_values": {"cpu_temp_c": [62, 64, 66, 70, 75, 80, 85]},
    "breach_detected": true,
    "breach_time": "2026-03-20T14:25:00Z",
    "lead_time_min": 25.0,
    "rationale": "Predicted Overheat: CPU load at 87% driving 0.35C/min rise",
    "alert_emitted": true
  }'
```

### 5.8. System Health [REQ-OPS-OBSERVABILITY]

```bash
curl http://localhost:3000/api/health
# {
#   "status": "healthy",
#   "components": {
#     "database": "connected",
#     "websocket": "connected",
#     "flight_link": "active"
#   },
#   "uptime_s": 7200,
#   "timestamp": "2026-03-20T14:00:00Z"
# }
```

---

## 6. REACT UI — GUÍA DE USO COMPLETA

### 6.1. Arrancar el dashboard

```bash
cd ground/ui
npm run dev
# → http://localhost:5173
```

### 6.2. Navegación

El sidebar izquierdo es persistente con 5 secciones y una barra de estado:

```
◇ ASTERION | GROUND CONTROL
  ◇◆ Pass Planner      /pass-planner
  ◇● Live Health       /live-health     ← vista por defecto
  ◇▲ Alerts            /alerts
  ◇≡ Audit Timeline    /timeline
  ◇◎ Twin Insights     /twin-insights

Indicadores (se actualizan cada 10s):
  Ground WS  ● verde = gateway conectado   ● rojo = sin conexión WS
  Flight Link ● verde = FSW conectado      ● ámbar = FSW desconectado
  Database    ● verde = DB sana             ● rojo = DB error
```

---

### 6.3. Pass Planner (`/pass-planner`)

**Qué hace:** Gestión completa del ciclo de vida de un pase orbital: ventanas de contacto → planes de comando → firma Ed25519 → envío al satélite.

#### Ventanas de contacto

| Acción | Dónde | Qué ocurre |
|--------|-------|-----------|
| **+ New Window** | Botón superior | Modal: `name`, `aos_time` (inicio pase), `los_time` (fin pase). Crea ventana en estado `SCHEDULED`. Genera evento `WINDOW_CREATED` en audit log |
| **Activate** | Botón junto a ventana | Transición `SCHEDULED → ACTIVE`. Solo las ventanas ACTIVE pueden recibir uploads |
| **Complete** | Botón junto a ventana activa | Transición `ACTIVE → COMPLETED`. Cierra el pase |
| **Cancel** | Botón junto a ventana | Transición `→ CANCELLED`. Irreversible |

**Estados de ventana:**
- `SCHEDULED` — Planificada, no activa aún
- `ACTIVE` — Pase en curso, acepta uploads de planes
- `COMPLETED` — Pase terminado (histórico)
- `CANCELLED` — Cancelada

#### Planes de comando

| Acción | Dónde | Qué ocurre |
|--------|-------|-----------|
| **+ New Plan** | Botón tras seleccionar ventana ACTIVE | Modal: `operator_name`, lista de comandos JSON `[{command_type, payload}]`. Crea plan en estado `DRAFT`. Genera evento `PLAN_CREATED` |
| **Sign (Ed25519)** | Botón junto a plan DRAFT | El browser genera/carga un keypair Ed25519 de localStorage, calcula `canonicalJSON(commands)`, firma con SHA-256 → Ed25519. Transición `DRAFT → SIGNED`. Genera evento `PLAN_SIGNED` |
| **Upload to Satellite** | Botón junto a plan SIGNED | Envía el plan al FSW via WebSocket gateway (mensaje `PLAN_UPLOAD`). Transición `SIGNED → UPLOADED`. Genera evento `PLAN_UPLOADED`. Falla con 503 si Flight no está conectado, 409 si la ventana no está ACTIVE |

**Estados de plan:**
- `DRAFT` — Creado, sin firmar
- `SIGNED` — Firmado Ed25519, listo para enviar
- `UPLOADED` — Enviado al satélite, esperando ejecución
- `EXECUTING` — FSW está ejecutando los comandos
- `COMPLETED` — Todos los comandos ejecutados con ACK
- `REJECTED` — FSW rechazó el plan (firma inválida u otro error)

**Tipos de comando disponibles (ejemplos):**
```json
{"command_type": "SET_PARAM",      "payload": {"param_name": "gain", "param_value": 3.5}}
{"command_type": "RUN_DIAGNOSTIC", "payload": {"subsystem": "THERMAL"}}
{"command_type": "REBOOT",         "payload": {}}
{"command_type": "SET_MODE",       "payload": {"mode": "SAFE"}}
```

---

### 6.4. Live Health (`/live-health`)

**Qué hace:** Monitor en tiempo real del estado del satélite vía WebSocket. Datos llegan cada ~1 segundo desde el FSW a través del gateway.

#### Elementos de la vista

**Banner de estado FSW** (parte superior, color cambia según estado):
| Estado | Color | Significado |
|--------|-------|-------------|
| `BOOT` | Azul | Iniciando, pre-nominal |
| `NOMINAL` | Verde | Operación normal |
| `SAFE` | Ámbar | Anomalía detectada, modo seguro activo |
| `CRITICAL` | Rojo | Fallo grave, intervención requerida |

**5 tarjetas de subsistema:**

| Subsistema | Métricas | Umbral de alerta |
|-----------|----------|-----------------|
| **THERMAL** | `cpu_temp_c`, `board_temp_c`, `heatsink_temp_c` | > 80°C → transición a SAFE |
| **POWER** | `voltage_v`, `current_ma`, `power_w`, `battery_soc` | Voltaje < 6.0V → transición a SAFE |
| **CPU** | `cpu_usage_pct`, `memory_usage_pct`, `disk_pct` | Indicativo, no dispara T3 |
| **COMMS** | `ws_connected`, `msg_queue_depth`, `error_rate` | Queue depth alto = posible outage |
| **FSW** | `state`, `uptime_s`, `wd_restarts` | `wd_restarts > 0` indica watchdog activo |

**Tabla de historial** (últimos 20 frames):
- Seq #, timestamp, estado FSW, CPU temp
- Se actualiza en cada frame de telemetría recibido

**Sin datos / FSW desconectado:** La vista muestra "No telemetry data" y el indicador Flight Link en ámbar.

---

### 6.5. Alerts (`/alerts`)

**Qué hace:** Panel de alertas activas — combina alertas del Digital Twin y eventos CRITICAL del log de auditoría.

#### Sección Twin Alerts

Muestra forecasts del modelo térmico/energético donde se ha detectado un breach inminente:
- **Modelo:** THERMAL o ENERGY
- **Lead time:** Minutos de antelación con que se detectó el breach (req: ≥ 15 min)
- **Rationale:** Explicación legible generada por el twin (ej: "CPU load at 87% driving 0.35C/min rise")
- **Breach indicator:** Tiempo estimado del breach

> En Fase 3 el twin no está integrado; las alertas aparecen cuando se inyectan forecasts manualmente via REST o Fase 4.

#### Sección Critical Events

Tabla de los últimos 20 eventos con `severity=CRITICAL`:
- Provienen del FSW vía WebSocket (`COMMAND_REJECTED`, `WD_RESTART`, etc.)
- Se actualizan en tiempo real cuando llega un `AUDIT_EVENT` CRITICAL via WebSocket

---

### 6.6. Audit Timeline (`/timeline`)

**Qué hace:** Visualización del log hash-chained SHA-256 de todos los eventos del sistema, con verificación de integridad.

#### Filtros disponibles

| Filtro | Opciones |
|--------|---------|
| Source | FLIGHT, GROUND, TWIN, SCHEDULER |
| Severity | INFO, WARNING, CRITICAL |
| Event Type | STATE_TRANSITION, WATCHDOG_RESTART, COMMAND_EXECUTED, COMMAND_REJECTED, SIGNATURE_INVALID, PLAN_SIGNED, PLAN_UPLOADED, TWIN_ALERT |

#### Tabla de eventos (hasta 200 registros)

| Columna | Significado |
|---------|------------|
| Time | Timestamp ISO del evento |
| Event Type | Tipo del evento (ver catálogo §5.6) |
| Source | Badge: FLIGHT (azul) / GROUND (verde) / TWIN (lila) / SCHEDULER (gris) |
| Severity | Badge: INFO (gris) / WARNING (ámbar) / CRITICAL (rojo) |
| Description | Texto legible del evento |
| Hash | Primeros 12 caracteres del SHA-256 del evento |

#### Verificar cadena de hashes

Botón **"Verify Chain"** → llama a `GET /api/events/verify`:
- **CHAIN INTACT** (verde): Todos los hashes encadenados son correctos. `break_at_index: null`
- **CHAIN BROKEN** (rojo): Se encontró una ruptura en la cadena. Indica tampering o corrupción. `break_at_index: N`

La cadena se reconstruye desde la DB ordenando por inserción física (ctid), no por timestamp, para soportar eventos de Flight con timestamps del pasado.

Los eventos se actualizan en tiempo real cuando llega un `AUDIT_EVENT` via WebSocket.

---

### 6.7. Twin Insights (`/twin-insights`)

**Qué hace:** Análisis de predicciones del Digital Twin — historial de forecasts, breaches detectados y verificación del requisito REQ-DT-EARLY-15m (≥ 15 min de antelación).

#### Métricas resumen (4 tarjetas)

| Tarjeta | Significado |
|---------|------------|
| Total Forecasts | Nº de forecasts almacenados |
| Breaches Detected | Nº de forecasts con `breach_detected: true` |
| Avg Lead Time | Promedio de minutos de antelación de los breaches |
| REQ-DT-EARLY-15m | PASS si todos los breaches tienen `lead_time_min ≥ 15`, FAIL si alguno < 15 |

#### Filtro por modelo

Dropdown: **All Models**, **THERMAL**, **ENERGY**
- Recarga la tabla con los forecasts del modelo seleccionado

#### Tabla de forecasts

| Columna | Significado |
|---------|------------|
| Time | Cuándo se generó el forecast |
| Model | THERMAL (modelo térmico RC 1er orden) o ENERGY (balance energético) |
| Horizon | Ventana de predicción en minutos (normalmente 30 min) |
| Breach | YES (rojo) / NO (verde) — si se predice superar un umbral |
| Lead Time | Minutos hasta el breach predicho. Verde ≥ 15 min, rojo < 15 min |
| Rationale | Explicación del modelo (ej: "Predicted Overheat: 0.35C/min rise") |

#### Cards de breach

Para cada breach detectado se muestra una tarjeta expandida con el rationale completo y el timestamp estimado del breach.

---

### 6.8. Flujo completo del operador (escenario nominal)

```
1. Arrancar servicios (§1.4)
2. Abrir http://localhost:5173
3. Verificar sidebar: Ground WS ●, Flight Link ●, Database ●

4. Pass Planner → "+ New Window"
   → Nombre: "Pass-042", AOS: 2026-03-20T14:00:00Z, LOS: 14:10:00Z

5. Pass Planner → "Activate" en la ventana creada
   → Estado: SCHEDULED → ACTIVE
   → Audit Timeline mostrará evento WINDOW_CREATED + STATUS_CHANGE

6. Pass Planner → "+ New Plan"
   → operator_name: "operador1"
   → commands: [{"command_type":"RUN_DIAGNOSTIC","payload":{"subsystem":"THERMAL"}}]
   → Estado: DRAFT
   → Audit Timeline: PLAN_CREATED

7. Pass Planner → "Sign (Ed25519)"
   → Browser firma con clave local (localStorage)
   → Estado: DRAFT → SIGNED
   → Audit Timeline: PLAN_SIGNED

8. Pass Planner → "Upload to Satellite"
   → Gateway envía PLAN_UPLOAD al FSW via WebSocket
   → Estado: SIGNED → UPLOADED → EXECUTING → COMPLETED
   → Live Health: FSW ejecuta el comando (visible en telemetría FSW)
   → Audit Timeline: PLAN_UPLOADED + COMMAND_EXECUTED

9. Audit Timeline → "Verify Chain" → CHAIN INTACT
```

---

### 6.9. Escenario de firma inválida

```bash
# Terminal adicional:
source .venv/Scripts/activate
python infra/fault_injector_bad_sig.py
```

**Qué ocurre en la UI:**
1. El FSW rechaza el plan → `COMMAND_NACK` vía WebSocket
2. Alerts: nuevo evento CRITICAL aparece en tiempo real
3. Audit Timeline: evento `COMMAND_REJECTED` con severity CRITICAL
4. Pass Planner: el plan pasa a estado `REJECTED`

---

## 7. BASE DE DATOS

### 7.1. Migraciones

```bash
cd ground

# DB de desarrollo
POSTGRES_PORT=5433 npx knex migrate:latest --knexfile knexfile.js

# DB de test
POSTGRES_PORT=5433 NODE_ENV=test npx knex migrate:latest --knexfile knexfile.js

# Rollback
POSTGRES_PORT=5433 npx knex migrate:rollback --knexfile knexfile.js

# Estado actual
POSTGRES_PORT=5433 npx knex migrate:status --knexfile knexfile.js

cd ..
```

### 7.2. Inspeccionar con psql

```bash
# Conectar a la DB de desarrollo
docker exec -it asterion-postgres psql -U asterion -d asterion

# Conectar a la DB de test
docker exec -it asterion-postgres psql -U asterion -d asterion_test

# Comandos psql útiles:
# \dt                           → Listar tablas
# \d contact_windows            → Schema de una tabla
# SELECT * FROM telemetry ORDER BY timestamp DESC LIMIT 5;
# SELECT * FROM audit_events ORDER BY timestamp DESC LIMIT 10;
# SELECT * FROM command_plans;
```

### 7.3. Las 6 tablas (ERD Art.2)

| Tabla | Propósito | Requisito |
|-------|-----------|-----------|
| `contact_windows` | Ventanas de contacto orbital | REQ-GND-PLAN |
| `command_plans` | Planes de comando firmados Ed25519 | REQ-SEC-ED25519 |
| `commands` | Comandos individuales con estado | REQ-COM-ZERO-LOSS |
| `telemetry` | Frames de telemetría por subsistema | REQ-COM-ZERO-LOSS |
| `audit_events` | Log hash-chained (SHA-256) | REQ-FSW-LOG-SECURE |
| `twin_forecasts` | Predicciones térmicas/energéticas | REQ-DT-EARLY-15m |

### 7.4. Credenciales PostgreSQL

```
Host:     localhost
Port:     5433 (Windows) / 5432 (Linux/macOS)
Database: asterion       (desarrollo)
          asterion_test  (tests)
User:     asterion
Password: asterion_dev
```

---

## 8. DOCKER

```bash
# Levantar stack
docker compose up -d

# Ver estado + health
docker compose ps

# Ver logs PostgreSQL
docker compose logs postgres -f

# Parar contenedor (preserva datos)
docker compose down

# Parar y BORRAR datos (reset completo)
docker compose down -v

# Recrear desde cero (post down -v):
docker compose up -d
# Esperar 5s, luego volver a migrar y crear asterion_test
```

**Nota:** El archivo `docker-compose.yml` usa puerto `5433:5432` en este entorno.
En Linux/macOS sin PostgreSQL local, cambiar a `5432:5432` y quitar `POSTGRES_PORT=5433`
de todos los comandos.

---

## 9. ESTRUCTURA DE DIRECTORIOS

```
asterion-one/
├── .venv/                            # Python virtualenv (local, no en git)
├── docker-compose.yml                # PostgreSQL (puerto 5433 en Windows)
├── pytest.ini                        # Python test config (asyncio_mode=strict)
├── README.md
├── docs/
│   ├── USAGE.md                      # Este archivo
│   ├── ICD.md                        # Interface Control Document
│   └── ADR/001-python-fsw.md
│
├── flight/                           # FLIGHT SEGMENT (Python)
│   ├── models.py                     # Data types (FSWState, TelemetryFrame, etc.)
│   ├── config.py                     # Parámetros configurables
│   ├── fsw_core.py                   # State machine + main loop
│   ├── sensor_sim.py                 # Simulación de telemetría con noise
│   ├── audit_logger.py               # Log hash-chained (SHA-256, JSONL)
│   ├── disk_queue.py                 # Store-and-forward FIFO persistente
│   ├── crypto_verifier.py            # Verificación Ed25519
│   ├── cmd_executor.py               # Ejecución de command plans
│   ├── comms_client.py               # WebSocket client + replay queue
│   ├── window_scheduler.py           # Simulación ventanas de contacto
│   ├── requirements.txt
│   └── tests/                        # 150 unit tests
│
├── ground/                           # GROUND SEGMENT (Node.js + PostgreSQL)
│   ├── package.json
│   ├── knexfile.js                   # Config DB (lee POSTGRES_PORT del env)
│   ├── scripts/
│   │   └── init-db.sql               # Vacío — crear asterion_test manualmente
│   ├── src/
│   │   ├── index.js                  # ← ENTRY POINT: arranca API + WS Gateway juntos
│   │   ├── api/
│   │   │   ├── server.js             # createApp() factory, 7 routers montados
│   │   │   ├── helpers.js            # asyncHandler, apiError
│   │   │   ├── routes/               # health, contactWindows, commandPlans,
│   │   │   │                         # commands, telemetry, events, twin
│   │   │   └── __tests__/            # server.test.js (38), bad_signature.test.js (4)
│   │   ├── db/
│   │   │   ├── manager.js            # 26 métodos DB (createConnection, migrations, CRUD)
│   │   │   ├── index.js              # (vacío — importar desde manager.js directamente)
│   │   │   ├── migrations/001_initial_schema.js
│   │   │   └── __tests__/manager.test.js  # 54 tests
│   │   ├── ws/
│   │   │   ├── gateway.js            # WsGateway (7 message types, /flight + /ui paths)
│   │   │   └── __tests__/gateway.test.js  # 19 tests
│   │   └── services/
│   │       ├── audit.js              # AuditService + createAuditService
│   │       │                         # (ctid ordering para Flight events tardíos)
│   │       ├── auditHash.js          # computeEventHash (SHA-256 compartido)
│   │       └── __tests__/audit.test.js  # 29 tests
│   └── ui/                           # REACT DASHBOARD (Vite)
│       ├── package.json
│       ├── vite.config.js
│       ├── src/
│       │   ├── App.jsx               # Sidebar + routing
│       │   ├── lib/
│       │   │   ├── api.js            # Cliente REST (/api)
│       │   │   ├── ws.js             # Cliente WebSocket (ws://localhost:8081/ui)
│       │   │   ├── crypto.js         # Ed25519 signing (tweetnacl, SD-1C protocol)
│       │   │   └── __tests__/
│       │   │       ├── canonical_json.test.mjs  # 17 tests
│       │   │       └── crypto.test.mjs          # 14 tests
│       │   └── views/
│       │       ├── PassPlannerView.jsx      # Ventanas + planes + firma + upload
│       │       ├── LiveHealthView.jsx       # Telemetría en tiempo real (5 subsistemas)
│       │       ├── AlertDashboardView.jsx   # Twin alerts + eventos CRITICAL
│       │       ├── AuditTimelineView.jsx    # Log hash-chained + verify chain
│       │       └── TwinInsightsView.jsx     # Forecasts + breach analysis
│
├── twin/                             # DIGITAL TWIN (Fase 4)
│   ├── requirements.txt              # numpy 2.x (1.26.4 no soporta Python 3.13)
│   └── tests/test_twin_smoke.py
│
└── infra/
    ├── fault_injector.py             # CLI: kill-process, thermal-spike, power-drop,
    │                                 #      network-outage, cascade-failure
    ├── fault_injector_bad_sig.py     # Inyecta firma corrupta via Ground API
    └── verify_canonical_json.py      # Verifica compatibilidad Python↔JS canonical JSON
```

---

## 10. REQUISITOS CUBIERTOS

| Requisito | Fase | Componente | Cómo verificar |
|-----------|------|-----------|----------------|
| REQ-FSW-STATE-01 | 0 | `fsw_core.py` | `pytest flight/tests/test_fsw_core.py` |
| REQ-FSW-WD-03s | 0 | `fsw_core.py` | `python infra/fault_injector.py inject kill-process` |
| REQ-FSW-LOG-SECURE | 1 | `audit_logger.py` + `audit.js` | `curl .../api/events/verify` |
| REQ-COM-ZERO-LOSS | 2 | `comms_client.py` + WS gateway | `python infra/fault_injector.py inject network-outage` |
| REQ-COM-P95 | 2 | `comms_client.py` | `pytest flight/tests/test_comms_client.py` |
| REQ-SEC-ED25519 | 3 | `crypto_verifier.py` + `crypto.js` | `python infra/fault_injector_bad_sig.py` |
| REQ-GND-PLAN | 3 | Ground API + React UI | UI Pass Planner view |
| REQ-OPS-OBSERVABILITY | 3 | Ground API `/health` | `curl .../api/health` |
| REQ-DT-EARLY-15m | 4 | `twin/` | Twin Insights → avg lead time ≥ 15 min |
| REQ-DT-RATIONALE | 4 | `twin/` | Twin Insights → rationale column |

---

## 11. TROUBLESHOOTING

### Ground API no arranca (ECONNREFUSED en Vite)

```bash
# Causa: no hay proceso Node sirviendo en puerto 3000
# Solución: arrancar el entry point correcto
cd ground && POSTGRES_PORT=5433 node src/index.js
# NO usar: node src/api/server.js  (solo exporta funciones, no arranca nada)
```

### PostgreSQL: "password authentication failed"

```bash
# Causa: PostgreSQL local (PG17) en puerto 5432 interfiere con Docker
# Solución: usar POSTGRES_PORT=5433 en todos los comandos Node.js
# Ver docker-compose.yml: ports: ["5433:5432"]
```

### `npm ci` falla con "no package-lock.json"

```bash
# Causa: no hay package-lock.json en el repo
# Solución: usar npm install
cd ground && npm install
cd ground/ui && npm install
```

### `npm test` falla en Windows

```bash
# Causa: el script en package.json usa NODE_OPTIONS='...' (sintaxis Unix)
# Solución: usar el comando largo directamente
cd ground
POSTGRES_PORT=5433 NODE_OPTIONS='--experimental-vm-modules' npx jest --forceExit --detectOpenHandles
```

### `python3` no encontrado en Windows

```bash
# Causa: Windows usa `python`, no `python3`
python --version    # Python 3.13.2 ✓
```

### numpy no instala en Python 3.13

```bash
# Causa: numpy==1.26.4 no tiene wheel para Python 3.13
# Solución: instalar numpy 2.x (API-compatible)
pip install "numpy>=2.0" --only-binary=:all:
```

### "Database asterion_test does not exist"

```bash
# La DB de test no se crea automáticamente (init-db.sql está vacío)
docker exec asterion-postgres psql -U asterion -c "CREATE DATABASE asterion_test OWNER asterion"
```

### Flight Link en ámbar (FSW no conectado)

```bash
# El FSW aún no se ha iniciado o no pudo conectarse al gateway
# Verificar que gateway está en puerto 8081:
curl http://localhost:3000/api/health  # components.websocket debe ser "connected"
# Luego arrancar el FSW:
source .venv/Scripts/activate && cd flight && python fsw_core.py
```

### WS Gateway: UI no recibe FLIGHT_STATUS inicial

```bash
# Race condition ya corregido en gateway.js
# (FLIGHT_STATUS se envía con setTimeout(fn,0) en vez de síncronamente)
# Si persiste, verificar que src/index.js arranca el gateway antes que la app Express.
```
