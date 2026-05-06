# Horarios Support — Plataforma de gestión de turnos

Sistema integral de planificación, fichaje y reporting para equipos de soporte
con turnos rotativos. Combina un bot de Slack para operación diaria con una
aplicación web para administración y análisis.

---

## 1. Roles y permisos

| Rol     | Origen                                      | Capacidades principales |
|---------|---------------------------------------------|-------------------------|
| **admin**   | `ADMIN_SLACK_IDS` env o `agents.role='admin'` | Todo lo de manager + settings, salarios, asignar roles, eliminar solicitudes, ver auditoría |
| **manager** | `MANAGER_SLACK_IDS` env o `agents.role='manager'` | Ver/editar turnos, aprobar solicitudes y swaps, ver reportes, gestionar agentes (sin datos sensibles), publicar planner |
| **agent**   | Linkeado en tabla `agents`                  | Ver su horario, fichar (clock in/out, break), pedir permisos/vacaciones, proponer swaps, ver detalle de su mes |
| **viewer**  | Login Slack sin agent row                   | Ve solo página "tu cuenta no está vinculada" |

Roles editables en caliente desde `/agentes/:id` (admin) — sin reinicio.

---

## 2. Bot de Slack

### Slash commands
- **`/horario-hoy`** — público. Muestra el horario del día actual agrupado por turno.
- **`/horario-status`** — público. Estado en vivo de todos los agentes (en turno, sin marcar, en break, finalizado).
- **`/horario-swap`** — agente linkeado. Inicia un intercambio de turno con otro agente.
- **`/solicitar`** — agente linkeado. Abre modal para pedir permiso o vacaciones.
- **`/horario-link`** — manager+admin. Vincular/desvincular usuarios de Slack a agentes.
- **`/horario-import`** — manager+admin. Importar horarios via JSON pegado.
- **`/punch-test`** / **`/punch-fix`** / **`/punch-reset`** — manager+admin. Herramientas operativas para fichaje.

### Mensajes automáticos
- **DM con botones de fichaje** al inicio del turno: Clock In / Break In (30/60 min) / Break Out / Clock Out.
- **Recordatorio configurable** N minutos antes del inicio del turno (default 5).
- **Aviso de tardanza** al manager si pasa el umbral configurado (default 15min) tras periodo de gracia (default 5min).
- **Aviso de break excedido** al agente y al manager cuando supera la duración elegida.
- **Auto-clockout** automático tras ventana configurable si el agente olvidó marcar salida.
- **DM a manager + admin** con resumen diario al canal de asistencia (configurable).
- **DM al agente** cuando un manager edita su turno desde `/horarios` web (add/remove/move).
- **DM cruzado** en swaps y solicitudes para todas las partes (requester, partner, managers).

### Validaciones
- Punch bloqueado si no tiene turno asignado para esa fecha+dept+shift (anti-spam).
- Break In bloqueado si quedan menos minutos al fin del turno que la duración elegida.
- Manager no puede auto-aprobar sus propias solicitudes; admin sí (consistente para approve y reject).

---

## 3. Web app

### `/` Dashboard
- Saludo personalizado + reloj UTC en vivo con punto pulsante.
- 5 stat cards con strip de color: En turno / Sin marcar / Sin clock out / Próximos (8h) / Finalizados.
- Tabla de turnos en vivo con status pills color-codeadas (active, break, alert, warning, upcoming, completed).
- Mobile: tabla → lista de cards apiladas con info compacta.

### `/mi-horario`
- Calendario mensual del agente con sus turnos como mini-cards (`L1.T 08:00–16:00`).
- 3 stat cards: Turnos del mes / Días libres / Zona horaria del agente.
- **Toggle UTC / TZ local** del agente (default UTC, persiste en localStorage).
- Indicador `↔` para turnos cambiados por swap aprobado.
- Mensaje amable si la cuenta no está vinculada.

### `/horarios` — vista operativa con 3 modos

#### Día
- Cada dept (L1/L2) en una card con sus 4 turnos (M/T/E/N).
- Cada turno con horario UTC + label + chips de agentes.
- Chips con primer nombre + indicador `*` si custom hours, badge de dept si presta de otro dept, `↔` si swap aprobado.
- Hover en chip muestra nombre completo + detalles.
- Sección `OFF · Tiempo libre` con agentes en vacaciones/permiso ese día (line-through, color cyan/amber).

#### Semana
- **Desktop**: grilla 7 días × 4 turnos por dept con celdas de chips.
- **Mobile**: stack vertical, 1 card por día con todos sus turnos y OFF dentro (resuelve la grilla apretada).
- Sticky header con días al scrollear vertical.

#### Mes
- Calendario tradicional con resumen por día (conteo por dept).
- Click en un día abre la vista Día.

#### Toolbar (todas las vistas)
- Date picker clickeable (input invisible sobre el label).
- Navegación ← / → con shift por periodo.
- Botón "Hoy" para volver a la fecha actual.
- Toggle UTC / TZ local del usuario que mira (default UTC).
- Active link highlighting en sidebar con la sección actual.

#### Modo edición (manager+admin)
Toggle ✏️ Editar activa edición inline:
- **× rojo** sobre cada chip → confirma + quita al agente del turno.
- **+ Agregar** en cada celda → modal con select de agente.
- **Click en chip (no en × ni +)** → modal "Mover agente" con grid de 8 turnos posibles (4 L1 + 4 L2). El turno actual queda disabled. Botón "🗑 Quitar" como atajo.
- Estado del modo persiste en localStorage entre Día y Semana.
- Cada acción dispara DM al agente afectado y entrada en `audit_log`.
- Tecla `Esc` cierra modales.

### `/solicitudes` — Permisos y vacaciones
- Lista filtrable por estado (todas, pendientes, aprobadas, rechazadas, canceladas).
- Status pills con punto de color al inicio.
- Manager/admin ven todas; agentes solo las suyas (incluyendo las que un manager creó a su nombre).
- Acciones por estado:
  - **Pendiente**: Aprobar / Rechazar (con motivo opcional) / Cancelar.
  - **Aprobada/cualquier**: Eliminar (manager+admin) — si era aprobada, **rollback de `days_off_entries`** automático para restaurar el horario original.
- Mobile: cards apiladas con todas las acciones inline.

### `/solicitudes/nueva`
- Manager/admin pueden crear a nombre de cualquier agente (select dropdown).
- Tipo: 📝 Permiso o 🏖️ Vacaciones.
- **Balance de vacaciones en vivo**: muestra usados/entitled del año, días que pide y disponibles tras esta solicitud (rojo si negativo).
- Validación de overlapping con solicitudes pendientes/aprobadas.

### `/agentes` — Gestión del equipo
- Lista de todos los agentes con dept badge, role chip, status pill (activo/inactivo).
- Salarios y ID solo visibles para admin con edición inline + modal "Aplicar aumento" que snapshotea anterior + calcula festivo (= salario/23).

### `/agentes/:slackId` — Ficha del agente
- **Hero** con avatar inicial color-hash, nombre, dept badge, role chip, slack_id + planner_id.
- **Tabs** organizan el form (no avalanche de 30 campos):
  - **👤 Identidad**: nombre, dept, role, admin user.
  - **📞 Contacto**: emails, teléfono, cumpleaños, dirección.
  - **💼 Trabajo**: cargo, fechas ingreso/egreso, evaluaciones, **días vacaciones/año** (con balance vivo del año), **zona horaria** IANA.
  - **🔒 Sensibles** (admin): cédula, salarios histórico, % ajuste, día festivo.
- Sticky footer con Cancelar / Guardar.
- Auto-jump a tab si validación falla.
- Persistencia de tab activa en localStorage.

### `/horarios/agente/:plannerId`
- Drill-down mes a mes del agente con cada día detallado:
  - Turno asignado o "Libre" (si vacaciones/permiso) o "—" (sin shift).
  - Estado: Programado / En turno / En break / Finalizado / Sin marcar / Sin clock out.
  - Punches con timestamp.
  - Indicadores de tardanza, exceso de break, swap.
- Stats del mes: turnos / libres / completos / tardes / excesos / sin clock out / alertas.
- Manager+admin ven cualquiera; agente ve solo el suyo (`/horarios/agente/<su_planner_id>`).

### `/reportes`
- Filtros: rango (presets `Este mes` / `Mes pasado` / `7d` / `30d` / custom), dept, agente.
- 6 stat cards con strip de color: Turnos / Completos / Sin marcar / Tardanzas (min) / Excesos break (min) / Horas trabajadas.
- Cards por dept con métricas resumidas.
- Tabla detallada por agente con 13 columnas (turnos, completos, sin marcar, tardanzas, min tarde, excesos break, min exceso, auto-clockouts, permisos, vacaciones, horas).
- Hover sobre números muestra fechas exactas de incidentes.
- **📥 Export CSV** con UTF-8 BOM (Excel-friendly), incluye detalle de fechas e incidentes.
- **🖨️ Imprimir** con print CSS (oculta sidebar/topbar).
- Mobile: cards apiladas con métricas resumidas.

### `/planner` — Editor visual de ciclos
- Editor cycle-based (4 ciclos A/B/C/D) con grilla 7 días × 4 turnos por dept.
- Sidebar con equipo, filtro multi-agente, días-off por ciclo, contador de turnos asignados.
- Quick-shift modal: agregar turno multi-día con un click (con opción de aplicar a todos los ciclos).
- Cell modal: editar agentes asignados a una celda + nota.
- Copy cycle: copiar ciclo origen a destino.
- **Auto-guardado** debounced (1.2s) en DB.
- Botón **"📅 Aplicar a fechas"** que toma el estado guardado + rango → preview de cambios → confirmar publica como `schedule_entries` reales.
- Estado compartido entre dispositivos (DB-backed, no localStorage).
- Skin coherente con el resto de la app (paleta ink, sombras layered).

### `/settings` (admin)
Configuración editable en caliente sin reiniciar:
- **Asistencia**: umbral tardanza, periodo gracia, recordatorio, lockout break, max break legacy, auto-clockout (gracia + ventana).
- **Ciclo**: fecha ancla + ciclo ancla.
- **Slack**: canal de asistencia.
- **Misc**: timezone display global.

### `/auditoria` (admin)
- Log filtrable de cambios manager/admin: shift edits, time-off resolutions, role changes, settings updates.
- Avatar circular del actor + action pill color-codeada por categoría.
- Summary humano + payload JSON colapsable para inspección técnica.
- Filtros: desde fecha / acción / actor / limit (50/100/200/500). Default últimos 30 días.

---

## 4. Sistema de turnos

### Ciclos rotativos
- **A / B / C / D**: 4 semanas que rotan automáticamente.
- Anchor configurable: una fecha + un ciclo en `/settings`.
- `cycleForDate(date)` calcula el ciclo de cualquier fecha respecto al anchor.

### Definición de turnos
4 turnos por dept × 2 depts = 8 shifts:
- **L1**: M (00–08), T (08–16), E (12–20), N (16–24)
- **L2**: M (03–11), T (11–19), E (15–23), N (19–03)

### Custom hours
Cualquier asignación puede tener `custom_start_hour` / `custom_end_hour` que sobreescriben el shift base.

### Swaps (intercambios)
- Agente A propone swap de su turno con agente B.
- B acepta/rechaza por DM.
- Si acepta, va a manager para aprobación final.
- Manager aprueba/rechaza por DM con motivo opcional.
- Al aprobar: ambos turnos quedan marcados con `source='swap'`. Indicador `↔` en chips.

### Time off (permisos / vacaciones)
- Solicitud → DM a managers + admins → aprobación.
- Al aprobar: crea `days_off_entries` con reason='vacaciones' o 'permiso' que bloquean el turno original.
- Eliminar solicitud aprobada → rollback automático de `days_off_entries`.
- Tracking anual de vacaciones: entitlement por agente, descuento por días aprobados, balance disponible visible en form de creación.

### Timezone
- Cada agente puede tener TZ IANA (ej: `America/Caracas`) — fallback al display global del sistema.
- Toggle UTC / Local en `/horarios` (TZ del que mira) y `/mi-horario` (TZ del agente).

---

## 5. Fichaje (punches)

### Botones DM
Al inicio del turno, agente recibe DM con:
- **Clock In** → marca entrada.
- **Break In 30 min** / **Break In 1h** → entra a break con duración elegida (registrada en `note: dur=N`).
- **Break Out** → sale de break. Si excede su duración elegida + grace, notifica manager con minutos de exceso.
- **Clock Out** → marca salida.

### Validaciones
- No fichar sin turno asignado.
- No break si quedan menos minutos que la duración del break.
- Notificaciones por late + grace + excess automáticas.

### Auto-clockout
- Si pasa N min después del fin del turno (gracia) sin clock_out, sistema lo marca automáticamente.
- Ventana configurable (no dispara después de M minutos).

---

## 6. Diseño y UX

### Sistema visual
- **Paleta**: `ink-50` → `ink-900` (azul tinta clásico, no AI-purple). Slate como neutral.
- **Tipografía**: Inter (Google Fonts) con feature settings cv11/ss01.
- **Cards**: `shadow-card` layered con highlight inset arriba, gradient blanco interno.
- **Pills/chips**: `pill` class con efecto raised (highlight blanco arriba + drop shadow + hover lift).
- **Botones primary**: `btn-primary` con gradient ink-700 → ink-800 + press visual.
- **Fondo**: textura sutil de puntos (radial-gradient cada 22px) tipo papel oficina.

### Layout
- **Sidebar vertical izquierda** (232px desktop) con brand, nav agrupada (Gestión / Sistema), user card abajo con role chip color-codeado y botón salir.
- **Mobile**: sidebar collapse a drawer (280px) con hamburguesa + top bar slim.
- **Active link** resaltado con gradient ink + shadow inset.

### Mobile
- Header bar slim con hamburger + logo + botón salir directo.
- Tablas → cards apiladas en `/dashboard`, `/solicitudes`, `/reportes`.
- Vista Semana → stack vertical por día.
- Toolbar de fechas adapta el tamaño (Sem D → solo D en pantalla chica).
- `overflow-x: hidden` global anti-overflow accidental.

### Roles visibles
- Admin: chip rosa.
- Manager: chip violeta.
- Agent: chip azul.
- Viewer: chip gris (con página minimal "no vinculado").

---

## 7. Integraciones técnicas

- **Slack OAuth (OpenID Connect)** para login en la web.
- **Slack Bolt SDK** (Socket Mode) para comandos, modales, botones y DMs.
- **SQLite** (better-sqlite3) con schema versionado por migraciones additivas.
- **Express + EJS + Tailwind** (CDN) para frontend.
- **Luxon** para fecha/hora con TZ.
- **PM2** en VPS para process management.
- **Caddy** reverse proxy (HTTPS).
- Auto-deploy via tar + scp + pm2 restart.

---

## 8. Roadmap pendiente

### Próximas features sugeridas

**Calendario / sync**
- 📅 **ICS feed por agente** para suscribir Google Calendar / Outlook / Apple Calendar (read-only, auto-sync).
- 🎂 **Eventos de cumpleaños / aniversarios / próxima evaluación** en el feed.

**Operacional**
- 🔔 **Cobertura sugerida**: cuando hay un turno vacío, sugerir qué agentes podrían cubrirlo.
- 📊 **Resumen mensual auto-DM al manager** los primeros días del mes con métricas del mes anterior.
- ⏰ **Tracking de horas extras** y alertas cuando un agente excede su quota semanal.
- 📝 **Comentarios en solicitudes** para conversar manager↔agente.
- 🛡️ **Políticas de tiempo libre**: máximo de días consecutivos, blackout dates.

**HR / análisis**
- 🎯 **Vacation auto-acumulación**: 1.25 días/mes en lugar de carga manual del entitlement.
- 📈 **Histórico de salarios y aumentos** con gráfica.
- 🗂️ **Export PDF** de reportes mensuales firmados.

**Plataforma**
- 🌙 **Dark mode**.
- 📱 **PWA / app instalable**.
- 🏢 **Multi-tenant** (varios equipos en la misma instancia).
- 🔁 **Backup/restore automático** de DB diario.
- 🪝 **Webhooks externos** para eventos clave (turno editado, solicitud resuelta).

### Roadmap operacional

- ✅ Cargar planner Q3 2026 (hecho)
- ⚠️ Verificar `ANCHOR_DATE` + `ANCHOR_CYCLE` en VPS (ahora editable desde `/settings`)
- Pruebas de carga / monitoring básico

---

_Documento generado a partir del estado actual del repo. Última actualización: 2026-05-06._
