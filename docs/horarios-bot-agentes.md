# Horarios Support — Manual del agente

Esta es la guía de uso del bot **Horarios Support** en Slack: cómo marcar entrada/salida y cómo solicitar cambios de turno.

---

## 1. Recibir el aviso de turno

Cinco minutos antes de cada turno, el bot **Horarios Support** te envía un DM en Slack con cuatro botones:

- 🟢 **Clock In** — marcar entrada
- ☕ **Break In** — comenzar break
- 🔄 **Break Out** — regresar del break
- 🔴 **Clock Out** — marcar salida

Los botones que aparecen dependen del estado del turno:

- Al inicio solo ves *Clock In*.
- Después de marcar entrada aparecen *Break In* y *Clock Out*.
- Durante el break aparecen *Break Out* y *Clock Out*.
- Después de *Clock Out* el mensaje queda fijado como "✅ Turno finalizado".

Si tu turno cruza medianoche (ej. L2 Noche 19:00–03:00), el mensaje y los botones siguen activos hasta que marques Clock Out.

---

## 2. Reglas de uso

### Entrada
- Si pasaste **15 minutos** del inicio sin marcar entrada, el bot te envía un recordatorio por DM y notifica al manager.

### Break
- **Máximo 1 hora.** Si pasaste de 60 minutos sin marcar Break Out, te llega un recordatorio. El tiempo extra queda registrado y se notifica al manager.
- **No Break In en la última hora del turno.** El bot rechaza Break In si quedan menos de 60 minutos para terminar. Es para evitar que el break se solape con la salida.

### Salida
- Marca Clock Out al final del turno. Si te olvidas, el manager puede corregirlo manualmente, pero queda registrado el olvido.

---

## 3. Solicitar un cambio de turno

Comando en Slack: `/horario-swap`

Se abre un formulario con cuatro campos:

1. **Mi fecha (la que entrego)** — el día tuyo que quieres ceder.
2. **Compañero** — la persona con quien intercambias.
3. **Fecha del compañero (la que recibo)** — el día del compañero que tomarás.
4. **Nota** (opcional) — explicación si la quieres dejar.

### Cómo funciona

1. Tú envías la solicitud (con al menos **24 horas de antelación** sobre el turno más cercano).
2. Tu compañero recibe un DM con los detalles y dos botones: **Aceptar** / **Rechazar**.
3. Si acepta, llega a Diego o Cindy para aprobación final.
4. Una vez aprobado, el horario se actualiza automáticamente y los tres reciben confirmación.

### Casos que cubre

- Mismo día / turnos diferentes (ej. yo entrego mi tarde por tu noche del mismo día).
- Días distintos (tú trabajas el viernes, tu compañero el sábado, swap).
- Cambio de día libre (uno libra lunes y trabaja domingo, el otro al revés).

### Reglas

- Solo turnos completos.
- Mínimo 24 h de antelación.
- Si ya tienes una solicitud pendiente que toca alguna de las fechas, la segunda queda bloqueada hasta resolver la primera.

---

## 4. Vacaciones / Time-off

**No se gestionan por el bot.** Sigue el flujo de siempre: pedírselo a Cindy por correo. Cuando se apruebe, el bot se sincroniza automáticamente y no recibirás DMs en tus días de vacaciones.

---

## 5. Ver mi turno o consultar el horario

| Comando | Qué hace |
|---|---|
| `/horario-hoy` | Turnos del día actual (todos los agentes, agrupados por turno) |
| `/horario-hoy 2026-05-15` | Turnos de una fecha específica |
| `/horario-status` | Quién está en turno ahora, quién no marcó, quién finalizó |

> Las horas se muestran en UTC y también en hora local (Colombia, UTC-5).

---

## 6. Problemas comunes

### No me llegó el DM con botones
- Verifica que tengas turno cargado para el día: `/horario-hoy`.
- Si estás en vacaciones aprobadas, es normal no recibir DM.
- Si crees que es un error, escribe a Diego o Cindy.

### Marqué algo por error
- Pídele al manager (Diego o Cindy) que use `/punch-fix` para corregir el fichaje.

### No puedo marcar Break In
- Si te dice "❌ No se permite Break In en la última hora del turno", es la regla — espera hasta el final del turno y marca Clock Out directo.

---

## 7. Resumen de comandos

| Comando | Para qué sirve |
|---|---|
| `/horario-swap` | Solicitar cambio de turno |
| `/horario-hoy [fecha]` | Ver el horario del día |
| `/horario-status` | Ver quién está en turno ahora |

Cualquier otra duda: escribe a Diego o Cindy.
