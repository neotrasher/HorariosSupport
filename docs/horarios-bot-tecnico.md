# Horarios Support — Configuración técnica

Documento solo para Diego. Acceso al VPS, ajuste de reglas, carga de nuevos trimestres, mantenimiento de la base de datos y troubleshooting técnico.

---

## 1. Stack

- **Bot**: Node.js 20 + TypeScript + Slack Bolt SDK (Socket Mode)
- **DB**: SQLite (better-sqlite3)
- **Scheduler**: node-cron + Luxon
- **Hospedaje**: VPS Ubuntu, gestionado vía PM2

---

## 2. Acceso al VPS

```
Host: 157.254.174.220
User: root
Path: /root/horarios-bot/
SSH key: ~/.ssh/horarios_bot_vps (privada)
```

Comando de conexión:

```bash
ssh -i ~/.ssh/horarios_bot_vps root@157.254.174.220
```

---

## 3. Comandos de mantenimiento (PM2)

```bash
# Estado del proceso
pm2 status

# Logs en vivo (Ctrl+C para salir)
pm2 logs horarios-bot

# Reiniciar después de cambios en código o .env
cd /root/horarios-bot
npm run build
pm2 restart horarios-bot --update-env

# Detener temporalmente (sin restart automático)
pm2 stop horarios-bot && pm2 save

# Volver a arrancarlo
pm2 start horarios-bot && pm2 save
```

---

## 4. Variables de entorno (`.env`)

Ubicación: `/root/horarios-bot/.env`

```ini
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...

ATTENDANCE_CHANNEL_ID=C0B0DP3T9V3        # canal #support-attendance
MANAGER_SLACK_IDS=UFGGA508M,URQU9UTEJ    # Diego, Cindy

LATE_THRESHOLD_MIN=15
REMINDER_LEAD_MIN=5
BREAK_IN_LOCKOUT_MIN=60
BREAK_MAX_MIN=60

ANCHOR_DATE=2026-04-13
ANCHOR_CYCLE=A

DISPLAY_TIMEZONE=America/Bogota

CRON_DISABLED=false                      # poner en true para silenciar cron temporalmente
LOG_LEVEL=info
```

Después de cambiar algo: `pm2 restart horarios-bot --update-env`.

---

## 5. Cargar el siguiente trimestre

El trimestre actual (13 abril → 5 julio 2026) ya está cargado. Cuando se acerque el siguiente:

### 5.1 Si el horario sigue saliendo de Homebase

1. En Homebase, vista mensual → menú de impresión → **"Save as PDF"** (Chrome o Edge).
   > ⚠️ NO uses "Microsoft Print to PDF" — pierde el texto y el parser no lo lee.
2. Bajar los 3-4 PDFs que cubren el nuevo trimestre.
3. Subir los PDFs al VPS:
   ```bash
   scp /ruta/local/agosto.pdf root@157.254.174.220:/tmp/
   ```
4. Conectarse y correr el parser:
   ```bash
   ssh -i ~/.ssh/horarios_bot_vps root@157.254.174.220
   cd /root/horarios-bot/scripts
   python3 parse_homebase.py /tmp/agosto.pdf 2026 > /tmp/agosto.json
   ```
5. Importar al bot (script de la sección 6).
6. Verificar con `/horario-hoy 2026-08-XX` en Slack.

### 5.2 Si Cindy arma el horario en el planner HTML

1. Cindy completa las semanas en `horarios-planner.html`.
2. Click "**Exportar**" → descarga JSON.
3. Pega el JSON con `/horario-import` (modal de Slack) si es chico, o lo cargas vía SQL (sección 6) si es muy grande.

### 5.3 Refresh mensual (vacaciones / trades nuevos)

Mismo flujo que carga inicial pero solo para el mes afectado. El parser y el script de import borran y reescriben **el rango del PDF importado**, así que se puede actualizar un mes sin tocar los demás.

---

## 6. Importar JSON al DB (volúmenes grandes)

```bash
ssh -i ~/.ssh/horarios_bot_vps root@157.254.174.220
python3 << 'EOF'
import json, sqlite3
DB = '/root/horarios-bot/data/bot.db'
conn = sqlite3.connect(DB)
cur = conn.cursor()
for fname in ['/tmp/agosto.json', '/tmp/septiembre.json']:
    d = json.load(open(fname))
    rng = d.get('range')
    if rng:
        cur.execute('DELETE FROM schedule_entries WHERE date >= ? AND date <= ?', (rng['start'], rng['end']))
        cur.execute('DELETE FROM days_off_entries  WHERE date >= ? AND date <= ?', (rng['start'], rng['end']))
    for e in d['entries']:
        cur.execute('''INSERT INTO schedule_entries
            (date, dept, shift_id, planner_id, custom_start_hour, custom_end_hour, note, source)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'import')''',
            (e['date'], e['dept'], e['shift_id'], e['planner_id'],
             e.get('custom_start_hour'), e.get('custom_end_hour'), e.get('note')))
    for d_ in d.get('days_off', []):
        cur.execute('INSERT OR IGNORE INTO days_off_entries (planner_id, date, reason) VALUES (?, ?, ?)',
            (d_['planner_id'], d_['date'], d_.get('reason')))
conn.commit()
print('Importado.')
EOF
```

---

## 7. Estructura del proyecto

```
horarios-bot/
├── package.json
├── tsconfig.json
├── ecosystem.config.js (PM2)
├── .env / .env.example
├── data/bot.db                  # SQLite (no se versiona)
├── scripts/
│   ├── parse_homebase.py        # PDF Homebase → JSON
│   └── send-buttons-to-inshift.js  # one-shot post-go-live
└── src/
    ├── index.ts                 # entry point, registra handlers + cron
    ├── config.ts                # env, SHIFTS, DAYS, CYCLES
    ├── db.ts                    # schema + migrate
    ├── services/
    │   ├── agents.ts
    │   ├── schedule.ts          # consultas por fecha
    │   ├── punches.ts
    │   └── swaps.ts             # lógica de swaps
    ├── commands/
    │   ├── horarioImport.ts
    │   ├── horarioLink.ts
    │   ├── horarioStatus.ts
    │   ├── horarioHoy.ts
    │   ├── horarioSwap.ts
    │   ├── punchFix.ts
    │   ├── punchTest.ts
    │   └── punchReset.ts
    ├── actions/
    │   ├── punchButtons.ts      # Clock In/Out · Break In/Out (con reglas)
    │   └── swapButtons.ts       # Aceptar/Rechazar · Aprobar/Rechazar
    ├── jobs/
    │   ├── shiftReminder.ts     # DM 5 min antes del turno
    │   ├── lateChecker.ts       # alerta si pasaron 15 min sin clock in
    │   └── breakOverdueChecker.ts  # alerta si break > 60 min
    └── ui/blocks.ts             # Block Kit (botones, posts, swap previews)
```

Deployar cambios:

```bash
cd "C:\Users\urdan\Documents\Playground\Claude proyectos\horarios-bot"
scp -i ~/.ssh/horarios_bot_vps -r src root@157.254.174.220:/root/horarios-bot/
ssh -i ~/.ssh/horarios_bot_vps root@157.254.174.220 "cd /root/horarios-bot && npm run build && pm2 restart horarios-bot --update-env"
```

---

## 8. Schema de la base de datos

| Tabla | Función |
|---|---|
| `agents` | Mapeo `slack_id ↔ planner_id`. Fuente: `/horario-link` |
| `schedule_entries` | Cada turno asignado por **fecha absoluta** (`date`, `dept`, `shift_id`, `planner_id`). Soporta `custom_start_hour`/`custom_end_hour` para partial shifts |
| `days_off_entries` | Vacaciones/días libres por fecha (`planner_id`, `date`, `reason`) |
| `punches` | Cada Clock In/Out/Break In/Out con timestamp UTC |
| `alerts_sent` | Idempotencia de alertas (un solo aviso por agente/turno/tipo) |
| `shift_messages` | DM original de cada turno (para actualizar el message en cada button click) |
| `swap_requests` | Histórico completo de solicitudes de swap (auditoría) |

---

## 9. Mapeo nombre Homebase → planner_id

Definido en `scripts/parse_homebase.py` (constante `NAME_TO_PID`). Si entra/sale un agente del equipo, hay que actualizar este mapeo + ejecutar `/horario-link` en Slack para vincular el nuevo `slack_id`.

| Planner | Nombre en Homebase | Dept |
|---|---|---|
| 1 | Moisés Cardona | L1 |
| 2 | Karol Cabrera | L1 |
| 3 | Alejandra Henao | L1 |
| 4 | Johan Muñoz | L1 |
| 5 | Nuviangi Ramirez | L1 |
| 6 | Jerónimo García | L1 |
| 7 | Laura Zambrano | L1 |
| 8 | Esteban Santa | L1 |
| 9 | Alixander Maldonado | L1 |
| 10 | Michael Cano | L1 |
| 11 | Nelly Riera | L2 |
| 12 | Rosana Gomez | L2 |
| 13 | Maribel Hernandez | L2 |
| 14 | Juan Carlos Tamayo (Liam) | L2 |
| 15 | Maria Velarde M | L2 |
| 16 | William Vega | L2 |
| 17 | Cindy Benitez | L2 |

---

## 10. Mapeo de turnos (rangos UTC)

Las horas en Homebase son UTC. Convención del bot:

| Rango Homebase | Bot |
|---|---|
| 12am–8am | L1.M (Mañana 00–08) |
| 8am–4pm | L1.T (Tarde 08–16) |
| 12pm–8pm | L1.E (Intermedio 12–20) |
| 4pm–12am | L1.N (Noche 16–24) |
| 3am–11am | L2.M (Mañana 03–11) |
| 11am–7pm | L2.T (Tarde 11–19) |
| 3pm–11pm | L2.E (Intermedio 15–23) |
| 7pm–3am | L2.N (Noche 19–03 día siguiente) |

> El tag `(L1)/(L2)` en Homebase es el **dept del agente**; el slot del turno se determina por las **horas**. Por ejemplo, "8am-4pm Maria Velarde M (L2)" se guarda como `dept=L1, shift_id=T` aunque Maria sea L2.

---

## 11. App de Slack

- **Workspace**: TeamSquad
- **App**: Horarios Support
- **Modo**: Socket Mode (no necesita IP pública)
- **Scopes**: `chat:write`, `chat:write.public`, `commands`, `im:write`, `im:history`, `users:read`, `app_mentions:read`
- **Slash commands registrados**: `/horario-import`, `/horario-link`, `/horario-status`, `/horario-hoy`, `/horario-swap`, `/punch-fix`, `/punch-test`, `/punch-reset` (todos con "Escape channels, users, and links" tildado)

---

## 12. Troubleshooting técnico

### El bot no responde a un comando

1. `pm2 status` → ver si está `online`. Si está `errored` o `stopped` → mirar logs.
2. `pm2 logs horarios-bot --lines 50` → buscar errores recientes.
3. Restart si es algo transitorio: `pm2 restart horarios-bot --update-env`.
4. Si el error persiste → revisar último cambio en código o `.env`.

### Pausar el bot temporalmente sin desinstalar nada

```bash
ssh -i ~/.ssh/horarios_bot_vps root@157.254.174.220
sed -i 's/^CRON_DISABLED=.*/CRON_DISABLED=true/' /root/horarios-bot/.env
pm2 restart horarios-bot --update-env
```

Reactivar igual pero con `=false`. Esto solo silencia los cron jobs (recordatorios + tardanzas + break excedido) — los slash commands y botones siguen funcionando.

### Cancelar un swap pendiente manualmente

Los swaps `pending_partner` o `pending_approval` no se cancelan solos. Si se necesita limpiar uno:

```bash
ssh -i ~/.ssh/horarios_bot_vps root@157.254.174.220
sqlite3 /root/horarios-bot/data/bot.db \
  "UPDATE swap_requests SET status='cancelled' WHERE id = 42"
```

Para listar swaps pendientes:

```bash
sqlite3 -header -column /root/horarios-bot/data/bot.db \
  "SELECT id, status, requester_slack_id, partner_slack_id, requester_date, partner_date FROM swap_requests WHERE status LIKE 'pending%';"
```

### Backup de la DB

```bash
ssh -i ~/.ssh/horarios_bot_vps root@157.254.174.220 "sqlite3 /root/horarios-bot/data/bot.db .dump" > backup-$(date +%Y%m%d).sql
```

Para restaurar:

```bash
scp backup-20260429.sql root@157.254.174.220:/tmp/
ssh -i ~/.ssh/horarios_bot_vps root@157.254.174.220 \
  "pm2 stop horarios-bot && rm /root/horarios-bot/data/bot.db && sqlite3 /root/horarios-bot/data/bot.db < /tmp/backup-20260429.sql && pm2 start horarios-bot"
```

### Revisar punches de un agente

```bash
sqlite3 -header -column /root/horarios-bot/data/bot.db \
  "SELECT type, ts, source, note, shift_date, shift_id FROM punches WHERE slack_id = 'U083L5AUGUF' ORDER BY ts DESC LIMIT 20;"
```

### Cambiar reglas (break max, lockout, antelación de swap)

Para `BREAK_IN_LOCKOUT_MIN`, `BREAK_MAX_MIN`, `LATE_THRESHOLD_MIN`, `REMINDER_LEAD_MIN`: edits en `.env` y `pm2 restart`.

Para los **24 h de antelación de swap**: hardcoded en `src/commands/horarioSwap.ts` (constante `MIN_HOURS_AHEAD`). Si se quiere hacer configurable, hay que sacarlo a `config.ts`. Cambio chico (5 min).

---

## 13. Repositorio

Local: `C:\Users\urdan\Documents\Playground\Claude proyectos\` — repo Git inicializado.

Recomendable subir a GitHub (privado) cuando haya tiempo, así Cindy o futuros devs pueden colaborar y queda backup off-VPS.
