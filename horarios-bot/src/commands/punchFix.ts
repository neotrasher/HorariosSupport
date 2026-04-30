import { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import { config, SHIFTS } from '../config';
import {
  recordPunch, PunchType, getShiftState,
  getShiftMessage, setShiftMessage, markAlertSent
} from '../services/punches';
import { getAgentBySlackId } from '../services/agents';
import { findScheduleEntry } from '../services/schedule';
import { punchButtonsBlocks } from '../ui/blocks';

/**
 * /punch-fix @user clock_in 2026-04-28T09:00 [note]
 * Manager-only command to insert a corrected punch.
 *
 * Auto-derives shift_date and shift_id from the agent's schedule for the given
 * timestamp (handles overnight shifts crossing midnight). Without that context
 * the punch wouldn't appear in the per-shift state queries.
 *
 * Also sends/updates the agent's shift DM with current button state so the
 * agent can keep marking from there (useful after a missed reminder).
 */
export function registerPunchFix(app: App) {
  app.command('/punch-fix', async ({ ack, command, respond, client }) => {
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

    const ctx = resolveShiftContext(slackId, ts);

    recordPunch(slackId, typeRaw as PunchType, {
      source: 'manual',
      ts,
      note,
      shiftDate: ctx?.shiftDate,
      shiftId: ctx?.shiftId
    });

    // Send/update the agent's DM with buttons so they can keep marking
    let dmStatus = '';
    if (ctx) {
      dmStatus = await syncShiftDM(client, slackId, ctx);
    }

    const ctxNote = ctx
      ? ` · turno ${ctx.shiftDate} ${ctx.dept}.${ctx.shiftId}${dmStatus}`
      : ' · ⚠️ sin shift asociado (timestamp fuera de cualquier turno del agente)';

    await respond({
      response_type: 'ephemeral',
      text: `✅ Punch registrado: <@${slackId}> · ${typeRaw} · ${ts.toFormat('yyyy-LL-dd HH:mm')} UTC${ctxNote}${note ? ` · _${note}_` : ''}`
    });
  });
}

/**
 * Send the shift's punch-buttons DM to the agent, or update the existing one
 * with the current state. Skips if the shift ended >2h ago (no point).
 * Returns a short suffix string for the manager response.
 */
async function syncShiftDM(
  client: any, slackId: string,
  ctx: { shiftDate: string; shiftId: string; dept: string }
): Promise<string> {
  const shift = SHIFTS[ctx.dept]?.[ctx.shiftId];
  if (!shift) return '';

  const entry = (() => {
    const a = getAgentBySlackId(slackId);
    return a ? findScheduleEntry(a.planner_id, ctx.shiftDate) : null;
  })();
  const startHour = entry?.custom_start_hour ?? shift.startHour;
  const endHour = entry?.custom_end_hour ?? shift.endHour;

  const baseDate = DateTime.fromISO(ctx.shiftDate, { zone: 'utc' });
  const start = baseDate.startOf('day').plus({ hours: startHour });
  const end = baseDate.startOf('day').plus({ hours: endHour });
  const now = DateTime.utc();

  // Don't bother if shift ended a long time ago
  if (now.diff(end, 'hours').hours > 2) return ' · DM no enviado (turno antiguo)';

  const state = getShiftState(slackId, ctx.shiftDate, ctx.shiftId);
  const blocks = punchButtonsBlocks({
    state, dept: ctx.dept, shift, shiftDate: ctx.shiftDate,
    startISO: start.toISO()!, endISO: end.toISO()!
  });
  const text = `Tu turno — ${ctx.dept} ${shift.label}`;

  const existing = getShiftMessage(slackId, ctx.shiftDate, ctx.shiftId);
  try {
    if (existing) {
      await client.chat.update({
        channel: existing.channel_id,
        ts: existing.message_ts,
        text, blocks
      });
      return ' · DM actualizado';
    }
    const im = await client.conversations.open({ users: slackId });
    const channel = im?.channel?.id;
    if (!channel) return ' · DM no enviado (no se pudo abrir IM)';
    const res = await client.chat.postMessage({ channel, text, blocks });
    if (res.ts) {
      setShiftMessage(slackId, ctx.shiftDate, ctx.shiftId, channel, res.ts);
      // Mark reminder as sent so the cron doesn't dispatch a duplicate later
      markAlertSent(slackId, ctx.shiftDate, ctx.shiftId, 'reminder');
    }
    return ' · DM enviado al agente';
  } catch (e: any) {
    console.error('punchFix syncShiftDM failed:', e);
    return ` · ⚠️ error enviando DM (${e?.data?.error || e?.message || 'desconocido'})`;
  }
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
    const end = baseDate.plus({ hours: endHour });
    const startWithGrace = start.minus({ minutes: 30 });
    const endWithGrace = end.plus({ minutes: 30 });
    if (ts >= startWithGrace && ts <= endWithGrace) {
      return { shiftDate: dateStr, shiftId: entry.shift_id, dept: entry.dept };
    }
  }
  return null;
}
