# Horarios Support — Documentación técnica

Stack, arquitectura, deploy, schema de base de datos y operación. Para uso de developers / DevOps / admin con acceso al server.

---

## 1. Stack

| Capa | Tecnología | Notas |
|---|---|---|
| Runtime | **Node.js 20+** + **TypeScript** | Compilado con `tsc` a `dist/` |
| Slack | **@slack/bolt** (Socket Mode) | No requiere IP pública |
| HTTP | **Express 5** + **EJS** | Server-side rendered, no SPA |
| CSS | **Tailwind CDN** | Sin build pipeline, paleta `ink` custom |
| DB | **SQLite** (better-sqlite3) | Synchronous, WAL mode |
| Sesiones | **express-session** + connect-sqlite3 | TTL 7 días, secure cookies en prod |
| Cron | **node-cron** | Jobs cada minuto + diarios |
| Process mgr | **PM2** | Cluster mode, autorestart |
| Reverse proxy | **Caddy** | HTTPS automático Let's Encrypt |
| PWA | Manifest + SW custom | Cache-first CDN, network-first HTML |

---

## 2. Arquitectura

```
┌────────────────────────────────────────────────────┐
│  Slack workspace                                    │
│   • Bot DM a agentes (Clock In/Out/Break)          │
│   • DMs a managers/admin (alertas, aprobaciones)   │
│   • Slash commands (/horario-hoy, /solicitar, ...) │
└────────────────┬───────────────────────────────────┘
                 │ Socket Mode (WebSocket out)
                 ▼
┌────────────────────────────────────────────────────┐
│  Node process (pm2 cluster)                         │
│   ┌──────────────┬───────────────┬──────────────┐  │
│   │ Slack Bolt   │ Express Web   │ Cron jobs    │  │
│   │ (handlers)   │ (EJS routes)  │ (every min + │  │
│   │              │               │  daily)      │  │
│   └──────────────┴───────────────┴──────────────┘  │
│           │            │            │              │
│           └────────────┼────────────┘              │
│                        ▼                            │
│              ┌─────────────────┐                    │
│              │ SQLite (better- │                    │
│              │  sqlite3, WAL)  │                    │
│              └─────────────────┘                    │
└────────────┬───────────────────────────────────────┘
             │ HTTPS (443)
             ▼
       ┌──────────┐
       │  Caddy   │  ← horarios.empresa.com
       └──────────┘
             │
             ▼
       Browsers / PWA
```

### Decisiones de arquitectura

- **Socket Mode** en lugar de webhooks: el bot conecta saliente a Slack, no necesita IP pública ni túneles. Sirve detrás de cualquier NAT.
- **SQLite** en lugar de Postgres: con 17 agentes la DB pesa <10 MB, las queries son síncronas (sin pool), backup es un `cp`. Postgres sería overkill.
- **Server-side rendering** con EJS: sin frontend build, sin SPA, navegación tradicional. Más fácil de mantener para un equipo chico.
- **Tailwind CDN**: sin pipeline. Trade-off: ~280 KB extra en el primer load (cacheable). A cambio: zero-config.
- **El "frontend" del planner** (`planner-editor.ejs`) es un editor SPA-like dentro de una sola página, hereda CSS standalone para drag & drop pesado.

---

## 3. Layout del repo

```
horarios-bot/
├── src/
│   ├── index.ts                    # entrypoint, registra Slack handlers + cron + web
│   ├── config.ts                   # env-driven config + SHIFTS catalog
│   ├── db.ts                       # SQLite open + migrate()
│   │
│   ├── services/                   # lógica de dominio (sin HTTP)
│   │   ├── agents.ts               # CRUD agentes + role merge env+DB
│   │   ├── schedule.ts             # turnos: insert, query, mover, cycleForDate
│   │   ├── punches.ts              # clock in/out/break + state machine
│   │   ├── timeOff.ts              # solicitudes (vacaciones/permiso) lifecycle
│   │   ├── reports.ts              # buildReports() agrega métricas + score
│   │   ├── audit.ts                # logAudit() + listAudit()
│   │   ├── settings.ts             # SETTING_DEFS + applyDbSettings()
│   │   ├── plannerState.ts         # JSON blob del planner cíclico
│   │   ├── calendarTokens.ts       # ICS feed UUIDs
│   │   ├── coverage.ts             # suggestCoverage() para solicitudes
│   │   ├── coverageHeatmap.ts      # buildHeatmap() agente·hora
│   │   └── adminInsights.ts        # KPIs del dashboard admin
│   │
│   ├── jobs/                       # cron tasks
│   │   ├── shiftReminder.ts        # 5min before shift → DM
│   │   ├── lateChecker.ts          # 15min late → alert
│   │   ├── breakOverdueChecker.ts  # break overflow
│   │   ├── forgotClockoutChecker.ts# auto-clockout
│   │   ├── dailyAlertsChecker.ts   # cumple + evaluaciones (13:00 UTC)
│   │   └── dbBackup.ts             # backup diario (03:00 UTC)
│   │
│   ├── commands/                   # slash commands de Slack
│   │   ├── horarioHoy.ts
│   │   ├── horarioStatus.ts
│   │   ├── horarioImport.ts        # /horario-import (admin)
│   │   ├── horarioLink.ts          # /horario-link (admin)
│   │   ├── horarioSwap.ts
│   │   ├── solicitar.ts
│   │   ├── punchFix.ts
│   │   ├── punchTest.ts
│   │   └── punchReset.ts
│   │
│   ├── actions/                    # Slack interactive components
│   │   ├── punchButtons.ts         # Clock In / Out / Break In / Out
│   │   ├── swapButtons.ts          # accept/reject swaps
│   │   └── timeOffButtons.ts       # approve/reject from DM
│   │
│   ├── ui/                         # Slack Block Kit builders
│   │   └── blocks.ts
│   │
│   └── web/
│       ├── server.ts               # Express setup, middleware, routes
│       ├── routes/
│       │   ├── auth.ts             # OAuth Slack + requireAuth/Admin/Manager
│       │   ├── dashboard.ts        # /
│       │   ├── miHorario.ts        # /mi-horario
│       │   ├── horarios.ts         # /horarios (day/week/month/heatmap)
│       │   ├── agente.ts           # /horarios/agente/:id
│       │   ├── agentes.ts          # /agentes
│       │   ├── reportes.ts         # /reportes + /reportes/export.csv
│       │   ├── solicitudes.ts      # /solicitudes (build factory)
│       │   ├── settings.ts         # /settings
│       │   ├── auditoria.ts        # /auditoria
│       │   ├── planner.ts          # /planner
│       │   ├── calendar.ts         # /cal/:token.ics (PUBLIC)
│       │   ├── calendarToken.ts    # /cal-token/{generate,revoke}
│       │   └── backups.ts          # /backups
│       └── views/
│           ├── partials/           # head, foot, nav, modal, viewSwitch, …
│           └── *.ejs               # una vista por route
│
├── public/                         # PWA static assets
│   ├── manifest.webmanifest
│   ├── sw.js
│   ├── icon.svg
│   └── icon-maskable.svg
│
├── data/                           # gitignored, prod-only
│   ├── bot.db                      # SQLite database
│   ├── sessions.db                 # express-session store
│   └── backups/                    # automatic backups (30d retention)
│
├── package.json
├── tsconfig.json
└── .env                            # NOT in repo
```

---

## 4. Variables de entorno

```bash
# ─── Slack ───────────────────────────────────────
SLACK_BOT_TOKEN=xoxb-…
SLACK_APP_TOKEN=xapp-…              # Socket Mode
SLACK_SIGNING_SECRET=…
SLACK_WEB_CLIENT_ID=…               # OAuth para login web
SLACK_WEB_CLIENT_SECRET=…
SLACK_WEB_REDIRECT_URI=https://horarios.ejemplo.com/auth/slack/callback

# ─── Roles (env override; se mergean con DB) ─────
MANAGER_SLACK_IDS=UFGGA508M,URQU9UTEJ
ADMIN_SLACK_IDS=UFGGA508M

# ─── Asistencia ──────────────────────────────────
LATE_THRESHOLD_MIN=15
REMINDER_LEAD_MIN=5
GRACE_PERIOD_MIN=5
BREAK_IN_LOCKOUT_MIN=60
BREAK_MAX_MIN=60
AUTO_CLOCKOUT_GRACE_MIN=30
AUTO_CLOCKOUT_WINDOW_MIN=120

# ─── Score puntualidad ───────────────────────────
PUNCT_WEIGHT_UNMARKED=1.0
PUNCT_WEIGHT_LATE=0.4
PUNCT_WEIGHT_AUTO_CLOCKOUT=0.5
PUNCTUALITY_START_DATE=             # vacío = sin cutoff

# ─── RRHH ────────────────────────────────────────
EVALUATION_REMINDER_DAYS=15

# ─── Backups ─────────────────────────────────────
DB_BACKUP_RETENTION_DAYS=30

# ─── Ciclo ───────────────────────────────────────
ANCHOR_DATE=2026-04-27
ANCHOR_CYCLE=A
DISPLAY_TIMEZONE=UTC

# ─── Web ─────────────────────────────────────────
WEB_PORT=3000
WEB_SESSION_SECRET=cambiame-en-prod
WEB_SECURE_COOKIES=true             # false en local
ATTENDANCE_CHANNEL_ID=C0B0DP3T9V3

# ─── Otros ───────────────────────────────────────
DB_PATH=./data/bot.db
LOG_LEVEL=info
CRON_DISABLED=false                 # true para desactivar todos los crones
```

> Casi todos los settings de asistencia / score / RRHH / ciclo / display TZ / backup retention también son **editables en caliente desde `/settings`** (la DB sobreescribe el env al arrancar).

---

## 5. Schema de la base de datos

### 5.1 Tablas principales

```sql
-- Agentes del equipo (PK = slack_id)
CREATE TABLE agents (
  slack_id TEXT PRIMARY KEY,
  planner_id INTEGER UNIQUE NOT NULL,
  name TEXT NOT NULL,
  dept TEXT NOT NULL,                  -- L1 | L2 | MGMT
  role TEXT NOT NULL DEFAULT 'agent',  -- agent | manager | admin
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT,
  -- Campos operativos (manager+admin pueden editar)
  admin_user, position, email_company, email_personal,
  start_date, end_date,
  last_evaluation_date, next_evaluation_date,
  birthdate, address, phone,
  vacation_days_per_year INTEGER, timezone TEXT,
  -- Campos sensibles (admin only)
  id_number TEXT,
  salary_current REAL, salary_previous REAL, salary_new REAL,
  last_adjustment_pct REAL, last_salary_adjustment_date TEXT,
  holiday_day_amount REAL
);

-- Cada turno asignado a un agente en una fecha específica
CREATE TABLE schedule_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,                  -- YYYY-MM-DD UTC
  dept TEXT NOT NULL,
  shift_id TEXT NOT NULL,              -- M | T | E | N
  planner_id INTEGER NOT NULL,         -- FK lógico → agents.planner_id
  custom_start_hour REAL,              -- override opcional
  custom_end_hour REAL,
  note TEXT,
  source TEXT NOT NULL DEFAULT 'import' -- import | swap | manual
);

-- Días libres (descanso, time-off aprobado, etc.)
CREATE TABLE days_off_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  planner_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  reason TEXT,                         -- 'time_off' | 'rest' | 'vacaciones' | 'permiso' | null
  UNIQUE(planner_id, date)
);

-- Marcaciones reales (clock in/out/break in/out)
CREATE TABLE punches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slack_id TEXT NOT NULL,
  type TEXT NOT NULL,                  -- clock_in | clock_out | break_in | break_out
  ts TEXT NOT NULL,                    -- ISO timestamp UTC
  source TEXT NOT NULL DEFAULT 'button',
  note TEXT,
  shift_date TEXT, shift_id TEXT       -- shift attribution
);

-- Solicitudes de tiempo libre
CREATE TABLE time_off_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_slack_id TEXT NOT NULL,
  type TEXT NOT NULL,                  -- 'permiso' | 'vacaciones'
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL,                -- 'pending' | 'approved' | 'rejected' | 'cancelled'
  approver_slack_id TEXT,
  approval_at TEXT, rejection_reason TEXT,
  approval_dm_targets TEXT,            -- JSON array {slack_id, channel, ts}
  requester_dm_channel TEXT, requester_dm_ts TEXT,
  created_at TEXT, source TEXT
);

-- Cambios de turno entre dos agentes
CREATE TABLE swap_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_slack_id, partner_slack_id TEXT NOT NULL,
  requester_date, partner_date TEXT NOT NULL,
  requester_snapshot, partner_snapshot TEXT NOT NULL,
  status TEXT NOT NULL,
  -- … timestamps + DM tracking
);
```

### 5.2 Tablas auxiliares

```sql
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT, updated_by TEXT
);

CREATE TABLE planner_state (        -- single-row blob (id=1)
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schedule_json TEXT NOT NULL,
  days_off_json TEXT NOT NULL,
  updated_at, updated_by TEXT
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor_slack_id TEXT, actor_name TEXT,
  action TEXT NOT NULL,             -- shift.add, timeoff.approve, settings.update, …
  target_kind TEXT, target_id TEXT,
  summary TEXT, payload TEXT        -- JSON
);

CREATE TABLE agent_calendar_tokens (
  slack_id TEXT PRIMARY KEY,
  token TEXT UNIQUE NOT NULL,       -- UUID
  created_at, last_used_at TEXT
);

CREATE TABLE daily_notifications (   -- dedup para cumple + eval reminders
  kind TEXT NOT NULL,                -- 'birthday' | 'evaluation_reminder'
  target TEXT NOT NULL,              -- agent slack_id
  date TEXT NOT NULL,                -- UTC date sent
  sent_at TEXT,
  PRIMARY KEY (kind, target, date)
);

CREATE TABLE alerts_sent (           -- dedup para tardanzas / breaks
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slack_id TEXT NOT NULL,
  shift_date, shift_id, alert_type TEXT NOT NULL,
  ts TEXT,
  UNIQUE(slack_id, shift_date, shift_id, alert_type)
);

CREATE TABLE shift_messages (        -- track DMs sent for shifts
  slack_id, shift_date, shift_id TEXT NOT NULL,
  channel_id, message_ts TEXT NOT NULL,
  PRIMARY KEY(slack_id, shift_date, shift_id)
);
```

### 5.3 Migraciones

`migrate()` en `src/db.ts` corre al arrancar. Para nuevos campos: usa `ALTER TABLE … ADD COLUMN` con `IF NOT EXISTS` (vía check de PRAGMA), no rompe DBs existentes.

Para CAMBIOS DE SCHEMA destructivos (renombrar columnas, etc.) → SQLite no los soporta directo. El proceso seguro es:

1. Crear tabla nueva con schema correcto
2. `INSERT INTO new SELECT … FROM old`
3. `DROP TABLE old`
4. `ALTER TABLE new RENAME TO old`
5. Hacer un backup ANTES (`/backups → ejecutar manual`)

---

## 6. Cron jobs

| Cron expression | Job | Acción |
|---|---|---|
| `* * * * *` | runShiftReminder | DM 5 min antes con botones |
| `* * * * *` | runLateChecker | Alerta a managers si tarde >15 min |
| `* * * * *` | runBreakOverdueChecker | Alerta si break excedido |
| `* * * * *` | runForgotClockoutChecker | Auto-clockout 30-120 min después |
| `0 13 * * *` | runDailyAlertsChecker | Cumpleaños + eval reminders |
| `0 3 * * *` | runDbBackup | Backup SQLite + prune retención |

Desactivar todos: `CRON_DISABLED=true`.

`runDailyAlertsChecker` también corre **al arrancar** (deduped vía `daily_notifications`).

---

## 7. Acceso al VPS (Diego)

```
Host:     157.254.174.220
User:     root
SSH key:  C:\Users\urdan\.ssh\horarios_bot_vps
Path:     /root/horarios-bot
```

Conexión rápida desde Windows:

```bash
ssh -i "C:\Users\urdan\.ssh\horarios_bot_vps" root@157.254.174.220
```

---

## 8. Deploy

### 8.1 Workflow actual

El VPS no tiene git. Deploy = build local + scp + untar + restart.

```bash
# 1. Build local
cd horarios-bot
npm run build                 # tsc → dist/

# 2. Bundle
tar -czf deploy.tar.gz dist src/web/views public

# 3. Subir + extraer + restart
scp -i ~/.ssh/horarios_bot_vps deploy.tar.gz root@157.254.174.220:/root/horarios-bot/
ssh -i ~/.ssh/horarios_bot_vps root@157.254.174.220 \
  "cd /root/horarios-bot && tar -xzf deploy.tar.gz && pm2 restart horarios-bot"
```

⚠️ Incluir `src/web/views` en el tarball — las views NO se compilan, se sirven desde el path original.

⚠️ Incluir `public/` cuando hayas tocado PWA (manifest, sw, iconos).

### 8.2 Deploy automatizado (recomendable mejorar)

Hoy lo hace Claude vía SSH. Si quieres simplificar, agregar a `package.json`:

```json
"scripts": {
  "deploy": "npm run build && tar -czf /tmp/dep.tar.gz dist src/web/views public && scp -i ~/.ssh/horarios_bot_vps /tmp/dep.tar.gz root@157.254.174.220:/root/horarios-bot/ && ssh -i ~/.ssh/horarios_bot_vps root@157.254.174.220 'cd /root/horarios-bot && tar -xzf /root/horarios-bot/dep.tar.gz && pm2 restart horarios-bot'"
}
```

### 8.3 First-time setup en VPS nuevo

```bash
# 1. Dependencias del sistema
apt update && apt install -y nodejs npm git
npm i -g pm2 && pm2 startup systemd

# 2. Código
cd /root && mkdir horarios-bot && cd horarios-bot
# scp code o git clone
npm install --production=false
npm run build

# 3. Datos (si migrando)
mkdir -p data
scp old-vps:/root/horarios-bot/data/bot.db data/
scp old-vps:/root/horarios-bot/.env .

# 4. Caddy (HTTPS auto)
apt install -y caddy
cat > /etc/caddy/Caddyfile <<EOF
horarios.empresa.com {
  reverse_proxy localhost:3000
}
EOF
systemctl reload caddy

# 5. Arrancar
pm2 start dist/index.js --name horarios-bot
pm2 save
```

Apuntar el DNS A record del subdominio al IP del server. Caddy emite cert automáticamente al primer request.

---

## 9. Migración a otro server

Ver sección 8.3 para el flujo. Específico:

1. **Backup desde `/backups`** → descargá el `.db` más reciente.
2. **Provisionar VPS** nuevo (Ubuntu 22.04+, 2 vCPU, 2 GB RAM, 40 GB SSD).
3. **Instalar stack** (Node, PM2, Caddy).
4. **Clonar/transferir código + .env + bot.db**.
5. **DNS**: cambiar A record al IP nuevo. Si el dominio cambia, actualizar `SLACK_WEB_REDIRECT_URI` y la redirect URL en api.slack.com.
6. **Cutover** (~5 min downtime):
   - `pm2 stop` en viejo
   - copia final del `bot.db`
   - `pm2 restart` en nuevo
7. **Verificar**: `/health`, login web, recibir DM del bot.

Slack **no requiere cambios** (Socket Mode no depende de IP).

---

## 10. Troubleshooting

### El bot dejó de responder en Slack

```bash
ssh root@157.254.174.220
pm2 logs horarios-bot --err --lines 50
```

Errores comunes:

| Síntoma | Causa | Fix |
|---|---|---|
| `Going to establish a new connection` repetido | Slack rate-limiting o token revocado | Verificar tokens en `.env`, regenerar si es necesario |
| `Unhandled event 'server explicit disconnect'` | Restart de pm2 mientras WebSocket activo | Normal, ignorar |
| `database is locked` | Otro proceso tiene la DB | Verificar que no haya 2 instancias de pm2 |
| `cannot read property 'role' of undefined` | Sesión inválida | Limpiar `data/sessions.db` |

### La web devuelve 500

```bash
pm2 logs horarios-bot --err --lines 30
```

El error handler global en `server.ts` loguea el método + path + stack trace.

### El score de un agente está mal

1. Verificar que esté en `/agentes` con `active=1` y `dept != MGMT`
2. Verificar que `vacation_days_per_year` esté seteado si esperas el saldo
3. `/settings → punctualityStartDate` apunta al día correcto?
4. Inspeccionar punches manualmente:
   ```bash
   sqlite3 data/bot.db "SELECT * FROM punches WHERE slack_id='U…' AND shift_date='2026-…' ORDER BY ts"
   ```

### El cron no dispara

```bash
pm2 logs horarios-bot --lines 100 | grep -i cron
```

Verificar `CRON_DISABLED` no está en `true`. El log al arrancar debe decir:
```
Cron: reminders 5m before · late 15m · break max 60m · … · daily 13:00 UTC · backup 03:00 UTC (retention 30d)
```

### Necesito acceso directo a la DB

```bash
ssh root@157.254.174.220
cd /root/horarios-bot
sqlite3 data/bot.db
```

⚠️ La DB está en WAL mode. Si modificas mientras pm2 corre, no causa corrupción pero los cambios pueden tardar en reflejarse. Mejor `pm2 stop` antes de operaciones DDL pesadas.

---

## 11. Importación de turnos

### 11.1 Vía Slack `/horario-import`

Comando admin. Pega un JSON con el formato de salida del planner. Reemplaza turnos en el rango especificado.

### 11.2 Vía web `/planner`

Editor visual. Después de editar la plantilla, "Aplicar al rango" inserta `schedule_entries` para esas semanas.

### 11.3 Manualmente con sqlite3

```sql
INSERT INTO schedule_entries (date, dept, shift_id, planner_id, source)
VALUES ('2026-05-15', 'L1', 'M', 7, 'manual');
```

---

## 12. Seguridad

- Todos los endpoints (excepto `/health`, `/cal/:token.ics`, `/static/*`, `/sw.js`) pasan por `requireAuth`.
- Rutas admin pasan por `requireAdmin`, manager por `requireManager`.
- ICS feed usa **UUID v4** como token; la URL es la única forma de acceder al calendario del agente.
- Sesiones en SQLite con TTL 7 días, secure cookies + httpOnly + sameSite=lax.
- OAuth Slack rate-limited (20 req/min por IP).
- Sensitive fields en agentes (`salary_*`, `id_number`) solo se exponen a admin.
- Audit log captura todos los cambios manuales con `actor_slack_id`.

---

## 13. Performance

Para 17 agentes el sistema tiene latencia <50ms en la mayoría de queries. Hot path:

- `buildReports()` itera todos los agents × dates en memoria. Para >100 agentes podría ser necesario indexar por `(slack_id, shift_date)` y hacer batch queries.
- `dashboard.ts` actualmente recomputa los insights en cada request. Si fuera lento → cache en memoria con TTL 60s.
- `punches` tiene índice `(slack_id, ts)` y `(slack_id, shift_date, shift_id)`. No hay tabla de monthly aggregates; cada query reagrega.

---

## 14. Roadmap técnico

Things que podemos atacar (no urgente):

- **Tests unitarios** con vitest: empezar por `cycleForDate`, `shiftWindow`, `computePunctuality`, `suggestCoverage`.
- **CI/CD**: GitHub Actions que corre tests + linter en cada PR.
- **Monitoring externo**: Uptime Robot pingueando `/health` cada 5 min.
- **Backup off-site**: rsync nocturno de `data/backups/` a S3 o NAS.
- **Push notifications via PWA**: hoy las alertas son DM Slack. La PWA tiene SW listo, falta agregar push subscriptions + endpoint.
- **Migrar a Postgres** si el equipo crece >100 agentes.
