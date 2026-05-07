# Horarios Support — Manual del agente

Guía completa para agentes: cómo marcar tus turnos en Slack y cómo usar el portal web.

---

## 1. El bot de Slack

### 1.1 Recibir el aviso de turno

5 minutos antes de cada turno, el bot **Horarios Support** te envía un DM con cuatro botones:

- 🟢 **Clock In** — marcar entrada
- ☕ **Break In** — comenzar break (te pregunta 30 o 60 min)
- 🔄 **Break Out** — regresar del break
- 🔴 **Clock Out** — marcar salida

Si no marcas Clock In a los **15 minutos** del inicio del turno, llega alerta a tu manager. Si te quedas en break más del tiempo elegido, te llega un recordatorio.

### 1.2 Si olvidas marcar el Clock Out

A los **30 minutos** después del fin del turno, si no marcaste salida, el sistema lo cierra automáticamente. Aparecerá como "auto-clockout" en los reportes (cuenta como leve incidencia, no como error grave).

### 1.3 Slash commands útiles

Estos los puedes ejecutar en cualquier canal o DM con el bot:

- `/horario-hoy` — qué turno tienes hoy
- `/horario-status` — tu estado actual (en turno / en break / fuera)
- `/horario-swap` — solicitar cambio de turno con un compañero (en Slack)
- `/solicitar` — abrir formulario de permiso o vacaciones (atajo, también puedes usar la web)

---

## 2. El portal web

URL: el subdominio de tu empresa (te lo da tu manager). Login con tu cuenta de Slack — un click.

### 2.1 Dashboard

La página de inicio muestra los turnos en vivo del equipo: quién está en turno, quién en break, sin marcar, próximos en las siguientes 8h, etc. Útil para saber con quién contás en este momento.

### 2.2 Mi horario `/mi-horario`

Calendario mensual de tus turnos con tarjetas de resumen arriba:

- **Turnos del mes** — total programados
- **Días libres** — descansos + permisos + vacaciones
- **Puntualidad 90d** — tu score 0-100 con grado A/B/C/D/F (basado en tus últimos 90 días)
- **Vacaciones {año}** — días disponibles vs total asignado
- **Tu zona** — la timezone que tienes configurada

Cada celda del calendario muestra el turno (`L1.M`, `L2.N`, etc.) con sus horas. Por defecto se muestran en **UTC**, pero puedes cambiar con el toggle a tu hora local.

🔄 Los turnos marcados con borde ámbar y `↔` son **swaps aprobados**.

#### 📅 Sincronizar con Google Calendar / Outlook

Al final de la página hay un botón "**Generar URL de calendario**". Te da un enlace privado tipo:

```
https://horarios.ejemplo.com/cal/abc123-uuid.ics
```

Cómo suscribirlo:

| App | Cómo |
|---|---|
| **Google Calendar** | Otros calendarios → Suscribir desde URL → pegar |
| **Outlook** | Calendarios → Agregar calendario → Suscribirse desde web |
| **Apple Calendar** | Archivo → Suscripción nueva |

Tu calendario se actualiza solo cada ~1 hora con cualquier cambio de turno. Incluye ±90 días de turnos.

⚠️ Si pierdes la URL o crees que se filtró, en "Opciones avanzadas" puedes **rotar** (genera URL nueva, la vieja deja de funcionar) o **revocar** acceso.

### 2.3 Solicitudes `/solicitudes`

Para pedir **permisos** o **vacaciones**.

**Crear:**
1. Click "Nueva"
2. Tipo (permiso o vacaciones), fecha desde/hasta, motivo opcional
3. Confirmar — al manager le llega DM en Slack para aprobar

**Estados:**
- 🟦 Pendiente — esperando manager
- 🟢 Aprobada — los días aparecen como libres en tu calendario
- 🔴 Rechazada — el manager dejó motivo (si lo escribió)
- ⚫ Cancelada — la cancelaste tú o el manager antes de aprobar

Solo ves tus propias solicitudes (a menos que seas manager).

Cuando creas una de **vacaciones**, la web te muestra cuántos días te quedan disponibles del año. No te deja exceder ese saldo.

#### Cambios de turno (swaps)

Diferente a "permiso/vacaciones": un swap es **intercambio entre dos agentes** del mismo dept para días específicos. Lo más fácil es usar `/horario-swap` en Slack:

1. Eliges con quién y qué días
2. El otro agente recibe DM y acepta/rechaza
3. Si acepta → al manager le llega para aprobar
4. Aprobado → ambos calendarios se actualizan

---

## 3. Instalar como app (PWA) en el teléfono

El portal web funciona como **app instalable**, sin pasar por la App Store / Play Store:

| Sistema | Cómo |
|---|---|
| **Android Chrome** | Aparece prompt "Instalar app", o desde menú ⋮ → "Instalar app" |
| **iOS Safari** | Botón Compartir → "Agregar a pantalla de inicio" |

Una vez instalada:
- Tiene su propio icono y se abre como app nativa
- En Android, mantén pulsado el icono → atajos rápidos a Mi horario / Solicitudes / Horarios
- Funciona offline para páginas que ya visitaste (verás la última versión cacheada)

---

## 4. Buenas prácticas

✅ **Marca Clock In apenas inicies tu turno**, aunque sea con 1 min de tolerancia. Tarde > 5 min cuenta como tardanza.

✅ **Siempre marca Break Out** al volver. Si el sistema cree que sigues en break, no podrás marcar Clock Out después.

✅ **Marca Clock Out manualmente** al terminar. El auto-clockout de los 30 min funciona pero penaliza levemente tu score.

✅ **Configura tu timezone** en `/agentes/tu-id` (o pídele al manager). Verás horas en tu hora local en lugar de UTC.

✅ **Solicita permisos con anticipación** para que el manager pueda planificar coberturas.

---

## 5. Preguntas frecuentes

**¿Por qué no me llegó el DM 5 min antes?**
- Probablemente no estás vinculado a un agente. Pídele al admin que ejecute `/horario-link` con tu user de Slack.
- Verifica que no tengas el bot silenciado / bloqueado.

**¿Puedo marcar desde la web?**
- No. El clock in/out es solo desde los botones del DM en Slack (es la fuente de verdad para tracking real).

**¿Qué cuenta para mi score de puntualidad?**

```
score = 100 × (1 − (sin_marcar×1.0 + tarde×0.4 + auto_clockout×0.5) / turnos_pasados)
```

Solo cuenta tus turnos **ya terminados** de los últimos 90 días. Los pesos son configurables por el admin.

- **A (95-100)**: excelente
- **B (85-94)**: bueno
- **C (70-84)**: aceptable
- **D (50-69)**: hay que hablar
- **F (<50)**: crítico

**¿Cómo cambio mis datos personales?**
- Pídele al manager. Por seguridad los agentes no editan su propio perfil (aún).

**¿Mi calendario sincronizado se ve en tiempo real?**
- Casi: depende de qué tan seguido tu app de calendario refresque (Google Calendar lo hace cada ~1 hora). Si necesitas ver un cambio inmediato, abre `/mi-horario` en el navegador.
