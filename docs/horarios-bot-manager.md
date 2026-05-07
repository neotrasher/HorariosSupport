# Horarios Support — Manual de manager / admin

Guía completa para roles **manager** y **admin**: gestión del equipo, planificación, aprobación de solicitudes y configuración del sistema.

> ⚙️ Para temas técnicos (DB schema, deploy, env vars, arquitectura), ver el doc separado **"Horarios Bot — Documentación técnica"**.

---

## 1. Roles

| Rol | Permisos clave |
|---|---|
| **agent** | Marcar turnos, ver su horario, crear solicitudes propias |
| **manager** | Todo lo del agent + ver horarios del equipo, editar turnos, aprobar/rechazar solicitudes, gestionar perfiles operativos, ver reportes, ver heatmap de cobertura |
| **admin** | Todo lo del manager + crear agentes nuevos, cambiar roles, ver/editar campos sensibles (salarios, ID), `/settings`, `/auditoria`, `/backups` |

Los roles se actualizan **en cada request** (sin necesidad de relogin) gracias al middleware `refreshSessionRole`.

---

## 2. Dashboard `/`

La home muestra dos secciones para ti:

### 2.1 Panel de insights (arriba, manager/admin)

**4 KPIs clicables:**

| KPI | Click va a | Notas |
|---|---|---|
| Score promedio (90d) | `/reportes?preset=last-30` | Verde ≥85, ámbar ≥70, rojo <70 |
| Solicitudes pendientes | `/solicitudes?status=pending` | Cuentas por aprobar/rechazar |
| Esta semana | — | Turnos · sin marcar · tarde |
| Atención requerida | `/auditoria` | Conteo de agentes con score D/F |

**6 paneles de detalle:**
- 🏆 Top 3 puntualidad
- ⚠ Atención requerida (D/F)
- 🌴 Vacaciones casi agotadas (≤3 disponibles)
- 📋 Próximas evaluaciones (30d, marcadas en rojo si ≤7d, ámbar si ≤15d)
- 🎂 Cumpleaños próximos (30d)

Solo aparecen si hay data. Cards vacías se ocultan.

### 2.2 Tabla de turnos en vivo

Quién está activo ahora, quién en break, sin marcar, próximos en 8h.

**Estados:** ● Activo · ☕ En break · ✓ Finalizado · ↗ Próximo · ! Sin marcar (alerta) · ◷ Sin clock out

---

## 3. Horarios `/horarios`

Vista del equipo. Switch entre **Día / Semana (default) / Mes / 🔥 Heatmap**.

### 3.1 Vista Día

Grid: filas = turnos (M, T, E, N por dept), columnas = chips con agentes asignados. Por defecto **modo lectura**.

Toggle "**✎ Editar**" en la barra superior:

- **× sobre un chip** → quita al agente del turno
- **+ Agregar** en una celda vacía → modal para asignar agente disponible
- **Click en un chip** → modal "Mover" a otro dept/turno del mismo día

Cada acción dispara un DM al agente afectado y queda en `/auditoria`.

### 3.2 Vista Semana

Misma lógica de edición que Día, pero 7 columnas. En mobile se apila vertical (un card por día).

### 3.3 Vista Mes

Calendario tradicional. Más para overview, no editable inline.

### 3.4 Heatmap 🔥

Densidad de agentes cubriendo cada hora UTC del mes. Tabla 24×N días.

- 🔴 **0 agentes** → alerta de hueco de cobertura
- 🟡 bajo (1 agente)
- 🟢 medio
- 🟢 fuerte (pico)

Filtros: **Todos / L1 / L2**. Stats: pico, mínimo, hora punta, total agente·hora.

Maneja correctamente turnos cross-medianoche: L1 Noche 19→27 atribuye 19-23 al día scheduled y 0-2 al siguiente.

### 3.5 Editar manualmente

Todas las ediciones quedan registradas en `/auditoria` con:
- Acción: `shift.add`, `shift.remove`, `shift.move`
- Actor (tu nombre)
- Payload con detalle (qué turno, qué dept, agente afectado)

El agente recibe DM en Slack tipo:
> 📅 Cambio en tu horario · Te asignaron al turno L1.M del 2026-05-15.

---

## 4. Solicitudes `/solicitudes`

### 4.1 Aprobar / Rechazar

Las pendientes muestran tres botones:
- 📋 **Cobertura** → ver candidatos para reemplazar (más abajo)
- ✓ **Aprobar** → el agente recibe DM, sus días pasan a "libres" en el calendario
- **Rechazar** → puedes escribir motivo opcional

Al aprobar **vacaciones**, se descuentan automáticamente del saldo del agente.

### 4.2 Sugerencias de cobertura inteligente 📋

Click en "Cobertura" para una solicitud pendiente. Verás:

**Por cada día afectado** (donde el solicitante tiene turno):
- Turno asignado (dept, hora)
- Lista de candidatos rankeados con:
  - Score de puntualidad 90d (con grade A-F)
  - Carga reciente (turnos en últimos 14 días)
  - ✓ Razones positivas (score alto, carga baja)
  - ⚠ Warnings (carga alta, día de descanso programado)
  - ★ El #1 marcado como "recomendado"

**Filtros duros**: solo agentes del mismo dept, sin turno ese día, sin time-off aprobado, sin vacaciones/permiso programado.

**Ranking**: score puntualidad desc → carga reciente asc.

Si no hay candidatos para un día → alerta roja, te toca decidir manualmente.

### 4.3 Eliminar solicitud aprobada

Restaura el horario original del agente. Quedará en audit. Úsalo solo si fue un error.

---

## 5. Agentes `/agentes`

Lista del equipo. Click en cualquiera abre su perfil.

### 5.1 Lista

**Para manager:** nombre, dept, posición, email, teléfono, ingreso, **vacaciones**, estado.

**Para admin:** además columnas de **salario actual / aumento / festivo** con edición inline (autosave al cambiar de campo). El botón "Aplicar" guarda un aumento como histórico (snapshot del salario anterior, fecha y %).

### 5.2 Perfil del agente `/agentes/:slack_id`

Tabs: **Identidad / Contacto / Trabajo / Sensibles** (sensibles solo admin).

**Operacional (manager+admin):** name, dept, position, email_company/personal, phone, address, start/end_date, last/next_evaluation_date, birthdate, vacation_days_per_year, timezone.

**Sensibles (admin only):** id_number, salary_current/previous/new, last_adjustment_pct, last_salary_adjustment_date, holiday_day_amount.

### 5.3 Crear nuevo agente (admin only)

Botón "+ Nuevo". Requeridos: `slack_id`, `planner_id` (numérico, único — debe coincidir con homebase), `name`, `dept` (L1/L2/MGMT). Role default = `agent`, admin puede crear como manager o admin desde el inicio.

### 5.4 Vincular agente nuevo a un user de Slack

Si una persona hace login en la web pero no está vinculada, ve un mensaje "tu cuenta no está vinculada". Para vincularla:

1. Crear el agente en `/agentes/nuevo` con su `slack_id` exacto
2. La próxima request del usuario refresca su rol automáticamente

---

## 6. Reportes `/reportes`

Tabla detallada por agente con:

- Score de puntualidad (pill A/B/C/D/F)
- Turnos / completos / sin marcar / tarde / min tarde
- Excesos de break / min exceso
- Auto-clockouts
- Permisos / vacaciones (días)
- Horas trabajadas

**Presets**: Este mes / Mes pasado / Esta semana / Semana pasada / Últimos 7 / Últimos 30. O rango custom.

**Filtros**: por dept o por agente individual.

**Export CSV**: botón en la cabecera, descarga con UTF-8 BOM (Excel detecta encoding correctamente).

**Hovers** en cifras: tooltip con fechas exactas de cada incidente.

---

## 7. Planner `/planner` (solo desktop)

Editor de la **plantilla cíclica** A/B/C/D × dept × día × turno. Aquí defines el patrón rotativo.

⚠️ Solo visible en desktop (en mobile aparece pantalla "🖥 Solo desktop"). El editor requiere arrastrar agentes entre celdas y mucho espacio horizontal.

**Flujo típico:**
1. Cargar agentes en cada celda del ciclo correspondiente
2. Marcar días libres
3. "Aplicar al rango de fechas" — proyecta el patrón a `schedule_entries` reales

**Cambios de fecha-ancla**: en `/settings → Ciclo de turnos` puedes cambiar `anchorDate` y `anchorCycle` para alinear qué semana es A/B/C/D.

---

## 8. Configuración `/settings` (solo admin)

Cambios se aplican **en caliente** (sin restart). Categorías:

### 8.1 Asistencia y breaks

- `lateThresholdMin` — umbral para marcar tardanza (default 15 min)
- `gracePeriodMin` — tolerancia antes de notificar (default 5)
- `reminderLeadMin` — minutos antes del turno para mandar el DM (default 5)
- `breakInLockoutMin` — bloqueo de Break In cerca del fin de turno (default 60)
- `breakMaxMin` — duración máxima de break legacy (default 60)
- `autoClockoutGraceMin` — gracia antes del auto-clockout (default 30)
- `autoClockoutWindowMin` — ventana en que aún puede dispararse (default 120)

### 8.2 Ciclo de turnos

- `anchorDate` — lunes de referencia (formato YYYY-MM-DD)
- `anchorCycle` — A/B/C/D que aplica esa semana

### 8.3 Slack

- `attendanceChannelId` — canal donde se publican avisos de cumpleaños y resúmenes

### 8.4 RRHH

- `evaluationReminderDays` — días antes de la próxima evaluación para alertar al admin (default 15)

### 8.5 Score de puntualidad

- `punctualityWeightUnmarked` — peso de "sin marcar" (default 1.0)
- `punctualityWeightLate` — peso de tardanza (default 0.4)
- `punctualityWeightAutoClockout` — peso de auto-clockout (default 0.5)
- `punctualityStartDate` — **fecha desde la que cuentan los turnos para el score** (YYYY-MM-DD o vacío). Útil si el bot empezó a operar después de cargar turnos: pones la fecha de inicio real y los turnos pre-bot dejan de penalizar.

### 8.6 Misc

- `displayTimezone` — IANA timezone default si el agente no tiene una propia
- `dbBackupRetentionDays` — días que se conservan los backups automáticos (default 30)

---

## 9. Auditoría `/auditoria` (solo admin)

Log de todos los cambios manuales. Filtros: desde / acción / actor / limit.

**Acciones registradas:**
- `shift.add`, `shift.remove`, `shift.move` — ediciones manuales en /horarios
- `timeoff.approve`, `timeoff.reject`, `timeoff.cancel`, `timeoff.delete`
- `agent.role.change` — cambios de rol
- `settings.update` — cambios de configuración
- `db.backup`, `db.backup.manual`, `db.backup.download` — backups

Cada evento muestra: avatar del actor, nombre, acción (con colores), resumen humano, payload JSON expandible.

---

## 10. Backups `/backups` (solo admin)

### 10.1 Backup automático

Cron diario a las **03:00 UTC** (~22:00 Bogotá). Usa la API `.backup()` de better-sqlite3 → atómica y segura mientras la DB está en uso.

Archivos en `data/backups/horarios-YYYY-MM-DD.db`. Retención configurable en `/settings`.

### 10.2 Backup manual

Botón "💾 Ejecutar backup ahora" en la página. Útil antes de un cambio grande.

### 10.3 Descargar

Cualquier backup listado tiene botón "Descargar" → bajas el `.db` para llevártelo offline.

⚠️ Los `.db` contienen TODO (incluyendo datos sensibles si los manejas). Tratalo como tal.

### 10.4 Restaurar

No hay botón de "restaurar" en la web (intencional, es operación delicada). Si necesitas restaurar:

```bash
# En el server
pm2 stop horarios-bot
cp data/bot.db data/bot.db.before-restore
cp data/backups/horarios-2026-05-01.db data/bot.db
pm2 start horarios-bot
```

---

## 11. Alertas automáticas

### 11.1 Tiempo real (cada minuto)

- **Recordatorio de turno** (5 min antes): DM al agente con botones
- **Tardanza** (15 min después de inicio sin Clock In): DM a managers + admins
- **Break excedido** (>30 o 60 min según lo elegido): DM al agente y a managers
- **Auto-clockout** (30-120 min después del fin): cierra el turno automáticamente

### 11.2 Diarias (13:00 UTC)

- 🎂 **Cumpleaños** → mensaje al canal de attendance
- 📋 **Evaluación próxima** → DM a admins X días antes (configurable, default 15)

Tabla `daily_notifications` deduplica para evitar resends si reinicias pm2 el mismo día.

---

## 12. Workflow típico del manager

### Lunes
- Revisar `/` → ver KPIs, agentes en atención, evaluaciones próximas
- `/horarios` → vista semana → ajustar swaps si los hay
- `/solicitudes?status=pending` → aprobar lo del fin de semana

### Daily
- DM de tardanzas / breaks excedidos durante el día
- `/` para chequeo rápido del equipo activo

### Mensual
- `/reportes` → preset "Mes pasado" → revisar puntualidad, exportar CSV para HR
- `/auditoria` → revisar cambios significativos
- `/backups` → ejecutar uno manual antes de cualquier cambio masivo (importar plantilla nueva, etc.)

---

## 13. Preguntas frecuentes

**Un agente nuevo no aparece en /horarios.**
- ¿Lo creaste con `planner_id` correcto? Verifica que coincida con el ID que usa Homebase.
- Después de crearlo en `/agentes`, hay que asignarle turnos: o desde `/horarios` (manual) o desde `/planner` aplicando una plantilla.

**Cambié el role de alguien a manager pero sigue sin ver /horarios.**
- El sistema actualiza el rol en cada request automáticamente. Hazle refresh a la página. Si aún así no funciona, revisa que el agente esté `active`.

**Aprobé unas vacaciones pero no se descontaron del saldo.**
- El cálculo es dinámico desde `time_off_requests` con `status='approved'`. Recarga el perfil del agente. Si tampoco aparece, revisa que la solicitud quedó realmente aprobada (no rechazada o cancelada).

**El score de un agente está mal porque tenía turnos pre-bot.**
- Usa `/settings → Score de puntualidad → Fecha inicio del score`. Pon ahí el día en que el bot empezó a trackear. Los turnos previos quedan invisibles para el score pero siguen visibles en `/reportes` como histórico.

**¿Puedo crear varios admins?**
- Sí, no hay límite. Por seguridad, recomiendo máximo 2-3 personas con rol admin.

**Quiero exportar todo el histórico para auditoría externa.**
- `/reportes` con preset que cubra el período → botón CSV. Para algo más completo, descarga un backup de `/backups` y léelo con SQLite browser o sqlite3.
