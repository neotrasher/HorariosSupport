import { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import { config, SHIFTS } from '../config';
import { recordPunch, PunchType } from '../services/punches';
import { getAgentBySlackId } from '../services/agents';
import { findScheduleEntry } from '../services/schedule';

/**
 * /punch-fix @user clock_in 2026-04-28T09:00 [note]
 * Manager-only command to insert a corrected punch.
 *
 * Auto-derives shift_date and shift_id from the agent's schedule for the given
 * timestamp (handles overnight shifts crossing midnight). Without that context
 * the punch wouldn't appear in the per-shift state queries.
 */
export function registerPunchFix(app: App) {
  app.command('/punch-fix', async ({ ack, command, respond }) => {
    await ack();

    if (!config.managerSlackIds.includes(command.user_id)) {
      await respond({ response_type: 'ephemeral', text: '❌ Solo managers.' });
      return;
    }

    const text = (command.text || '').trim();
    const m = text.match(/^<@([A-Z0-9]+)(?:\|[^>]+)?>\s+(\w+)\s+(\S+)(?:\s+(.+))?$/);
    if (!m) {
      await respond({
        response_type: 'ephemeral',
        text: 'Uso: `/punch-fix @user clock_in|clock_out|break_in|break_out 2026-04-28T09:00 [nota]`'
      });
      return;
    }

    const [, slackId, typeRaw, tsRaw, note] = m;
    const validTypes = ['clock_in', 'clock_out', 'break_in', 'break_out'] as const;
    if (!validTypes.includes(typeRaw as any)) {
      await respond({ response_type: 'ephemeral', text: `❌ Tipo inválido. Válidos: ${validTypes.join(', ')}` });
      return;
    }

    const ts = DateTime.fromISO(tsRaw, { zone: 'utc' });
    if (!ts.isValid) {
      await respond({ response_type: 'ephemeral', text: '❌ Fecha inválida (formato ISO: 2026-04-28T09:00)' });
      return;
    }

    // Resolve shift context: which shift of the agent covers this timestamp?
    const ctx = resolveShiftContext(slackId, ts);

    recordPunch(slackId, typeRaw as PunchType, {
      source: 'manual',
      ts,
      note,
      shiftDate: ctx?.shiftDate,
      shiftId: ctx?.shiftId
    });

    const ctxNote = ctx
      ? ` · turno ${ctx.shiftDate} ${ctx.dept}.${ctx.shiftId}`
      : ' · ⚠️ sin shift asociado (timestamp fuera de cualquier turno del agente)';

    await respond({
      response_type: 'ephemeral',
      text: `✅ Punch registrado: <@${slackId}> · ${typeRaw} · ${ts.toFormat('yyyy-LL-dd HH:mm')} UTC${ctxNote}${note ? ` · _${note}_` : ''}`
    });
  });
}

/**
 * Find which shift covers a given UTC timestamp for a specific agent. Checks the
 * day of the timestamp AND the previous day (for overnight shifts that end after
 * midnight). Uses custom_start/end_hour overrides if present.
 */
function resolveShiftContext(slackId: string, ts: DateTime): { shiftDate: string; shiftId: string; dept: string } | null {
  const agent = getAgentBySlackId(slackId);
  if (!agent) return null;

  const today = ts.toUTC().startOf('day');
  const yesterday = today.minus({ days: 1 });

  for (const baseDate of [today, yesterday]) {
    const dateStr = baseDate.toFormat('yyyy-LL-dd');
    const entry = findScheduleEntry(agent.planner_id, dateStr);
    if (!entry) continue;
    const shift = SHIFTS[entry.dept]?.[entry.shift_id];
    if (!shift) continue;
    const startHour = entry.custom_start_hour ?? shift.startHour;
    const endHour = entry.custom_end_hour ?? shift.endHour;
    const start = baseDate.plus({ hours: startHour });
    // Allow grace window: from 30 min before start until 30 min after end (covers
    // late-night corrections, overnight shifts, etc.)
    const end = baseDate.plus({ hours: endHour });
    const startWithGrace = start.minus({ minutes: 30 });
    const endWithGrace = end.plus({ minutes: 30 });
    if (ts >= startWithGrace && ts <= endWithGrace) {
      return { shiftDate: dateStr, shiftId: entry.shift_id, dept: entry.dept };
    }
  }
  return null;
}
