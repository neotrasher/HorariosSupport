# Horarios Support — Manual del manager

Documento para Diego y Cindy. Cubre los comandos exclusivos, aprobación de cambios de turno, monitoreo del equipo y resolución de incidencias del día a día.

> ⚙️ Para temas técnicos (acceso al VPS, cargar nuevos trimestres, ajustar reglas, schema de DB), ver el doc separado **"Horarios Bot — Configuración técnica"**.

---

## 1. Comandos exclusivos de manager

| Comando | Qué hace |
|---|---|
| `/punch-fix @user clock_in 2026-04-28T09:00 [nota]` | Insertar un fichaje manualmente (corregir un olvido del agente) |
| `/punch-test [@user] [L1\|L2] [M\|T\|E\|N] [YYYY-MM-DD]` | Mandar un DM con botones de prueba (sin args = a ti mismo, turno por defecto L1.T hoy) |
| `/punch-reset [@user] [YYYY-MM-DD]` | Limpiar fichajes de una fecha (para retestear) |
| `/horario-link @user planner_id [L1\|L2]` | Vincular un usuario de Slack con un `planner_id` |
| `/horario-link unlink @user` | Desvincular un usuario |
| `/horario-link` (sin args) | Listar todos los agentes vinculados |

Tipos válidos para `/punch-fix`: `clock_in`, `clock_out`, `break_in`, `break_out`. La fecha va en formato ISO UTC (`2026-04-28T09:00`).

---

## 2. Aprobar cambios de turno

Cuando un agente acepta una solicitud de su compañero, **Diego y Cindy** reciben un DM con preview + botones **Aprobar / Rechazar**. El primero que actúe gana; al otro se le actualiza el mensaje a "ya resuelto por @persona".

La aprobación aplica el swap en el bot automáticamente.

> ⚠️ **Importante mientras estamos en fase de prueba**: actualizar también Homebase manualmente para mantener sincronía. Cuando se importe el siguiente PDF, el bot se realinea con Homebase, así que cualquier swap aprobado solo en Slack se pierde si no se reflejó en Homebase antes del refresh.

---

## 3. Monitoreo en tiempo real

### Canal de asistencia

Los fichajes se postean automáticamente en `#support-attendance`:

> 🟢 *Maria Velarde* marcó entrada · L2 T · 11:02 UTC
>
> ☕ *Maria Velarde* comenzó break · L2 T · 14:30 UTC
>
> 🔄 *Maria Velarde* regresó del break · L2 T · 14:42 UTC · ⚠️ +12 min extra
>
> 🔴 *Maria Velarde* marcó salida · L2 T · 19:01 UTC

### DMs automáticos que reciben Diego y Cindy

- 🔴 Si un agente no marca entrada **15 min** después del inicio.
- ⏰ Si un agente lleva más de **60 min** en break sin marcar Break Out.
- 🔄 Cuando un agente finaliza un break con exceso (informativo).
- 🔁 Cuando llega una solicitud de cambio de turno para aprobar.

### Ver el estado del equipo

`/horario-status` devuelve (solo visible para ti):

- 🟢 En turno
- 🔴 Sin marcar
- 🟡 Olvidó clock out
- ⏳ Próximos
- ✅ Finalizados

Útil para hacer un barrido rápido en cualquier momento del día.

---

## 4. Reglas vigentes

| Regla | Valor actual |
|---|---|
| Recordatorio de inicio de turno (DM con botones) | 5 min antes |
| Margen antes de alertar tardanza | 15 min después del inicio |
| Antelación mínima para solicitar swap | 24 h |
| Bloqueo de Break In al final del turno | últimos 60 min |
| Duración máxima de break | 60 min |

> Para cambiar cualquiera de estos valores → ver doc técnico.

---

## 5. Resolución de incidencias frecuentes

### Un agente no recibió su DM con botones

1. Verificá que esté vinculado: `/horario-link` (sin args lista todos).
2. Verificá que tenga turno cargado para esa fecha: `/horario-hoy YYYY-MM-DD`.
3. Si está marcado de vacaciones / time-off, es normal que no reciba DM.
4. Si nada de lo anterior aplica → ver doc técnico (puede ser bot caído).

### Un agente olvidó marcar entrada / salida / break

```
/punch-fix @user clock_in 2026-04-28T09:00 olvidó marcar
```

Se puede usar para cualquiera de los 4 tipos. La nota es opcional pero recomendable para auditar.

### Un agente marcó algo por error

Mismo `/punch-fix` con el tipo correcto y la hora correcta. El bot guarda todos los punches; el último de cada tipo es el que vale para el estado.

### Un swap quedó pendiente y los agentes desaparecieron

Las solicitudes pendientes no se cancelan solas. Avisá a Diego para que la cancele manualmente (requiere acceso técnico).

### El bot no responde a un comando

Avisá a Diego — probablemente el bot esté caído o necesite reinicio (requiere acceso técnico).

### Necesitamos pausar el bot temporalmente

Si por algún motivo hay que silenciar el bot un rato (mantenimiento, fin de semana, lo que sea), Diego lo hace desde el VPS. No se puede pausar desde Slack.

---

## 6. Mientras dure la fase de prueba

- Slack es el flujo primario. Homebase queda como respaldo.
- Si un agente reporta que el bot falla, indicarle marcar en Homebase y avisarles que use `/punch-fix` después.
- Cualquier swap aprobado en Slack también se debe espejar en Homebase manualmente (al menos hasta el próximo refresh de PDF).
- Reportar incidencias o cosas raras a Diego para que las anote.

---

## 7. Roadmap (Fase 2)

A largo plazo, el plan es reemplazar Homebase completo con una app propia:

- Vista web read-only del horario para agentes
- Solicitudes de vacaciones con flujo de aprobación dentro del sistema
- Histórico de fichajes consultable por agente
- Reportes mensuales (horas trabajadas, exceso de break, tardanzas)
- Integración con nómina

Mientras tanto: Homebase sigue siendo la **fuente de verdad** y el bot se sincroniza con cada refresh de PDF.
