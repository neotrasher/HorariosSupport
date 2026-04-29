import { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import { config } from '../config';
import { listAgents } from '../services/agents';
import { getAllShiftsForDate, shiftWindow, cycleForDate } from '../services/schedule';

/** /horario-hoy — listado completo del día agrupado por turno. */
export function registerHorarioHoy(app: App) {
  app.command('/horario-hoy', async ({ ack, respond, command }) => {
    await ack();
    const arg = (command.text || '').trim();
    const date = arg ? DateTime.fromISO(arg, { zone: 'utc' }) : DateTime.utc().startOf('day');
    if (!date.isValid) {
      await respond({ response_type: 'ephemeral', text: '❌ Fecha inválida (formato: YYYY-MM-DD)' });
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
        const names = list
          .map(s => agentByPid.get(s.planner_id)?.name || `#${s.planner_id}`)
          .sort()
          .join(', ');
        return `*${dept} ${shiftId}* ${sample.shift.label} ${w.start.toFormat('HH:mm')}–${w.end.toFormat('HH:mm')}\n${names}`;
      });

    await respond({
      response_type: 'ephemeral',
      text: `${tzNote}*${date.toFormat('yyyy-LL-dd')}* (UTC) — Sem ${cycle}\n\n${sections.join('\n\n')}`
    });
  });
}
