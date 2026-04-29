# Horarios Support — Workspace

Workspace de Diego para el sistema de horarios y fichaje del equipo de support.

## Componentes

- **`horarios-planner.html`** — planner standalone (HTML+JS) que Cindy usa para armar el horario del próximo trimestre. Exporta JSON.
- **`horarios-bot/`** — bot de Slack (Node.js + TypeScript + Bolt SDK + SQLite). Manda DMs con botones 5 min antes de cada turno y alerta tardanza.
  - `src/` — código fuente del bot
  - `scripts/parse_homebase.py` — parser one-shot del PDF "Save as PDF" de Homebase a JSON importable

## Flujo operativo

1. Cindy mantiene el horario del trimestre en Homebase (vacaciones, trades aprobados).
2. Diego descarga PDFs por mes desde Homebase (Print → "Save as PDF" en Chrome/Edge).
3. `python3 scripts/parse_homebase.py mes.pdf 2026 > mes.json` extrae JSON.
4. Importar al bot vía SQL directo (ver script abajo) o `/horario-import` para datasets chicos.

## Despliegue del bot

Ver `horarios-bot/README.md` (TBD). Resumen:

- VPS Ubuntu, gestionado vía PM2.
- `npm run build && pm2 restart horarios-bot --update-env`.

## Comandos Slack

- `/horario-import` — modal para JSON
- `/horario-link` — vincular usuario Slack ↔ planner_id
- `/horario-status` — quién está en turno ahora
- `/horario-hoy [YYYY-MM-DD]` — turnos del día
- `/horario-swap` — solicitar intercambio (flow: solicitante → compañero → manager)
- `/punch-fix` — corregir un fichaje manualmente (manager)
- `/punch-test` — disparar DM de prueba (manager)
- `/punch-reset` — limpiar fichajes para retestear (manager)
