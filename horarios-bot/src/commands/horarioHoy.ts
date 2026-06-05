import { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import { config } from '../config';
import { listAgents, getAgentBySlackId } from '../services/agents';
import { getAllShiftsForDate, shiftWindow, cycleForDate } from '../services/schedule';
import { listUpcomingBreaks } from '../services/breaks';

/** /horario-hoy — listado completo del día agrupado por turno.
 *
 *  Subcomando: /horario-hoy breaks (o /horario-hoy 8h)
 *    Lista las reservas + breaks en curso de las próximas 8 horas.
 */
export function registerHorarioHoy(app: App) {
  app.command('/horario-hoy', async ({ ack, respond, command }) => {
    await ack();
    const arg = (command.text || '').trim().toLowerCase();

    // Subcomando: breaks / 8h / slots — lista las próximas 8h de breaks
    if (arg === 'breaks' || arg === '8h' || arg === 'slots') {
      const invoker = getAgentBySlackId(command.user_id);
      const tz = (invoker?.timezone) || config.displayTimezone || 'UTC';
      const tzLabel = tz === 'UTC' ? 'UTC' : (tz.split('/').pop() || 'local').replace(/_/g, ' ');
      const items = listUpcomingBreaks({ hoursAhead: 8 });
      if (items.length === 0) {
        await respond({
          response_type: 'ephemeral',
          text: `🍽️ *Próximas 8h de breaks* — no hay reservas ni breaks en curso.`
        });
        return;
      }
      const lines = items.map(it => {
        const local = DateTime.fromISO(it.slot_start, { zone: 'utc' }).setZone(tz).toFormat('HH:mm');
        const dur = it.durationMin === 60 ? '1h' : `${it.durationMin}m`;
        const tag = it.status === 'in_break' ? '🟠 ahora' : (it.status === 'taken' ? '✓ tomada' : '📌 reservada');
        return `• \`${local}\` (${tzLabel}) — *${it.name}* · ${it.dept}.${it.shift_id} · ${dur} · _${tag}_`;
      });
      await respond({
        response_type: 'ephemeral',
        text: `🍽️ *Próximas 8h de breaks* (${items.length})\n${lines.join('\n')}`
      });
      return;
    }

    const date = arg ? DateTime.fromISO(arg, { zone: 'utc' }) : DateTime.utc().startOf('day');
    if (!date.isValid) {
      await respond({ response_type: 'ephemeral', text: '❌ Fecha inválida (formato: YYYY-MM-DD) o subcomando inválido. Usa `breaks` para ver los próximos breaks.' });
      return;
    }

    const agents = listAgents();
    const agentByPid = new Map(agents.map(a => [a.planner_id, a]));
    const cycle = cycleForDate(date);
    const shifts = getAllShiftsForDate(date);

    const localNow = DateTime.utc().setZone(config.displayTimezone);
    const tzNote = config.displayTimezone !== 'UTC'
      ? `_Hora actual: ${DateTime.utc().toFormat('yyyy-LL-dd HH:mm')} UTC · ${localNow.toFormat('yyyy-LL-dd HH:mm')} ${config.displayTimezone}_\n\n`
      : '';

    if (!shifts.length) {
      await respond({
        response_type: 'ephemeral',
        text: `${tzNote}*${date.toFormat('yyyy-LL-dd')}* (Sem ${cycle}) — sin turnos cargados`
      });
      return;
    }

    // Group by dept + shift
    const groups = new Map<string, typeof shifts>();
    for (const s of shifts) {
      const key = `${s.dept}|${s.shift.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(s);
    }

    const sections = Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, list]) => {
        const [dept, shiftId] = key.split('|');
        const sample = list[0];
        const w = shiftWindow(date, sample);
        const sStart = Math.floor(w.start.toJSDate().getTime() / 1000);
        const sEnd = Math.floor(w.end.toJSDate().getTime() / 1000);
        const sUtc = w.start.toFormat('HH:mm');
        const eUtc = w.end.toFormat('HH:mm');
        const names = list
          .map(s => agentByPid.get(s.planner_id)?.name || `#${s.planner_id}`)
          .sort()
          .join(', ');
        return `*${dept} ${shiftId}* ${sample.shift.label} ${sUtc}–${eUtc} UTC ` +
               `(local <!date^${sStart}^{time}|${sUtc}>–<!date^${sEnd}^{time}|${eUtc}>)\n${names}`;
      });

    await respond({
      response_type: 'ephemeral',
      text: `${tzNote}*${date.toFormat('yyyy-LL-dd')}* (UTC) — Sem ${cycle}\n\n${sections.join('\n\n')}`
    });
  });
}
