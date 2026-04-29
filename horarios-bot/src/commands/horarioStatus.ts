import { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import { config } from '../config';
import { listAgents } from '../services/agents';
import { getAllShiftsForDate, shiftWindow } from '../services/schedule';
import { getShiftState } from '../services/punches';

/** /horario-status — quién está en turno ahora, quién falta, quién finalizó. */
export function registerHorarioStatus(app: App) {
  app.command('/horario-status', async ({ ack, respond }) => {
    await ack();
    const now = DateTime.utc();
    const agents = listAgents();
    const agentByPid = new Map(agents.map(a => [a.planner_id, a]));

    // Today + yesterday (for night shifts spanning midnight)
    const today = now.startOf('day');
    const yesterday = today.minus({ days: 1 });

    const shiftsToday = getAllShiftsForDate(today);
    const shiftsYesterday = getAllShiftsForDate(yesterday);

    type Row = { agent: string; dept: string; shift: string; window: string; status: string };
    const inShift: Row[] = [];
    const finished: Row[] = [];
    const upcoming: Row[] = [];
    const missed: Row[] = [];
    const forgotOut: Row[] = [];

    const considerShift = (s: typeof shiftsToday[number], baseDate: DateTime) => {
      const w = shiftWindow(baseDate, s);
      const agent = agentByPid.get(s.planner_id);
      if (!agent) return;
      const shiftDate = baseDate.toFormat('yyyy-LL-dd');
      const state = getShiftState(agent.slack_id, shiftDate, s.shift.id);

      const row: Row = {
        agent: agent.name,
        dept: s.dept,
        shift: `${s.shift.id} (${s.shift.label})`,
        window: `${w.start.toFormat('HH:mm')}–${w.end.toFormat('HH:mm')}`,
        status: ''
      };

      // Before shift starts
      if (now < w.start) {
        const minsTo = Math.round(w.start.diff(now, 'minutes').minutes);
        if (minsTo <= 60) {
          row.status = `⏳ inicia en ${minsTo}m`;
          upcoming.push(row);
        }
        return;
      }

      // After shift ends
      if (now > w.end) {
        if (state === 'completed') {
          row.status = `✅ finalizado`;
          finished.push(row);
        } else if (state === 'in' || state === 'on_break') {
          // Worked but never clocked out
          const overMin = Math.round(now.diff(w.end, 'minutes').minutes);
          row.status = `🟡 olvidó clock out (+${overMin}m)`;
          forgotOut.push(row);
        }
        // state === 'off' for past shifts: didn't show at all (no value adding it; clutter)
        return;
      }

      // Inside shift window
      if (state === 'in') {
        row.status = '🟢 en turno';
        inShift.push(row);
      } else if (state === 'on_break') {
        row.status = '🟠 en break';
        inShift.push(row);
      } else if (state === 'completed') {
        row.status = '✅ finalizado (temprano)';
        finished.push(row);
      } else {
        // state === 'off' → never clocked in despite shift starting
        const lateMin = Math.round(now.diff(w.start, 'minutes').minutes);
        row.status = `🔴 sin marcar (+${lateMin}m)`;
        missed.push(row);
      }
    };

    for (const s of shiftsToday) considerShift(s, today);
    for (const s of shiftsYesterday) {
      // Only night shifts that cross into today
      if (s.endHour > 24) considerShift(s, yesterday);
    }

    const fmt = (rows: Row[]) =>
      rows.length
        ? rows.map(r => `• ${r.agent} — ${r.dept} ${r.shift} ${r.window} · ${r.status}`).join('\n')
        : '_ninguno_';

    const localNow = now.setZone(config.displayTimezone);
    const localLine = config.displayTimezone !== 'UTC'
      ? ` · ${localNow.toFormat("yyyy-LL-dd HH:mm")} ${config.displayTimezone}`
      : '';

    const sections: string[] = [
      `*🟢 En turno (${inShift.length})*\n${fmt(inShift)}`,
      `*🔴 Sin marcar (${missed.length})*\n${fmt(missed)}`
    ];
    if (forgotOut.length) {
      sections.push(`*🟡 Olvidó clock out (${forgotOut.length})*\n${fmt(forgotOut)}`);
    }
    sections.push(`*⏳ Próximos (1h, ${upcoming.length})*\n${fmt(upcoming)}`);
    if (finished.length) {
      sections.push(`*✅ Finalizados hoy (${finished.length})*\n${fmt(finished)}`);
    }

    await respond({
      response_type: 'ephemeral',
      text: `*Estado · ${now.toFormat("yyyy-LL-dd HH:mm")} UTC${localLine}*\n\n` +
            sections.join('\n\n')
    });
  });
}
