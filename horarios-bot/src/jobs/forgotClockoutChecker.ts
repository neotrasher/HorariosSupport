import { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import { config, SHIFTS } from '../config';
import {
  listInShiftAgents, recordPunch, alertAlreadySent, markAlertSent
} from '../services/punches';
import { findScheduleEntry } from '../services/schedule';
import { getAgentBySlackId } from '../services/agents';
import { attendancePostBlocks } from '../ui/blocks';

/**
 * Runs every minute. For each agent currently 'in' (clocked in or returned from break)
 * whose shift ended >= AUTO_CLOCKOUT_GRACE_MIN ago and < AUTO_CLOCKOUT_WINDOW_MIN ago,
 * record an auto clock_out at the shift end timestamp + notify everyone.
 */
export async function runForgotClockoutChecker(app: App) {
  const now = DateTime.utc();
  const inShift = listInShiftAgents();

  for (const a of inShift) {
    const agent = getAgentBySlackId(a.slack_id);
    if (!agent) continue;

    const entry = findScheduleEntry(agent.planner_id, a.shift_date);
    if (!entry || entry.shift_id !== a.shift_id) continue;
    const shift = SHIFTS[entry.dept]?.[entry.shift_id];
    if (!shift) continue;

    const startHour = entry.custom_start_hour ?? shift.startHour;
    const endHour = entry.custom_end_hour ?? shift.endHour;
    const baseDate = DateTime.fromISO(a.shift_date, { zone: 'utc' });
    const shiftEnd = baseDate.startOf('day').plus({ hours: endHour });
    const minsAfterEnd = now.diff(shiftEnd, 'minutes').minutes;

    if (minsAfterEnd < config.autoClockoutGraceMin) continue;
    if (minsAfterEnd > config.autoClockoutWindowMin) continue;
    if (alertAlreadySent(a.slack_id, a.shift_date, a.shift_id, 'auto_clockout')) continue;

    // Skip if agent is on break (last_type === 'break_in') — handled separately
    if (a.last_type === 'break_in') continue;

    // Record auto clock_out at shift end timestamp
    recordPunch(a.slack_id, 'clock_out', {
      source: 'auto',
      ts: shiftEnd,
      shiftDate: a.shift_date,
      shiftId: a.shift_id,
      note: 'auto: olvidó marcar salida'
    });
    markAlertSent(a.slack_id, a.shift_date, a.shift_id, 'auto_clockout');

    const endStr = shiftEnd.toFormat('HH:mm');
    const minsRound = Math.round(minsAfterEnd);

    // DM agent
    try {
      const im = await app.client.conversations.open({ users: a.slack_id });
      const ch = (im as any).channel?.id;
      if (ch) {
        await app.client.chat.postMessage({
          channel: ch,
          text: `⚠️ Te olvidaste de marcar *Clock Out* en tu turno ${entry.dept} ${shift.label} (${a.shift_date}).\n` +
                `Lo registramos automáticamente a las *${endStr} UTC* (hora de fin de turno).\n` +
                `Si trabajaste más tiempo, avisa a Diego o Cindy para corregirlo.`
        });
      }
    } catch (e) {
      console.error('forgot-clockout agent DM failed:', e);
    }

    // Post in attendance channel (highlighted as auto)
    if (config.attendanceChannelId) {
      try {
        await app.client.chat.postMessage({
          channel: config.attendanceChannelId,
          text: `⚠️ ${agent.name} · auto clock_out (olvidó marcar)`,
          blocks: [{
            type: 'context',
            elements: [{
              type: 'mrkdwn',
              text: `🟡 *${agent.name}* — *auto clock_out (olvidó marcar)* · ${entry.dept} ${entry.shift_id} · fin ${endStr} UTC · detectado +${minsRound}m`
            }]
          }]
        });
      } catch (e) {
        console.error('forgot-clockout attendance post failed:', e);
      }
    }

    // DM managers
    const mgrText = `🟡 *${agent.name}* olvidó marcar Clock Out — auto-cerrado a fin de turno (${endStr} UTC) · ${entry.dept} ${entry.shift_id} ${a.shift_date} · detectado +${minsRound}m`;
    for (const mgrId of config.managerSlackIds) {
      try {
        const im = await app.client.conversations.open({ users: mgrId });
        const ch = (im as any).channel?.id;
        if (ch) await app.client.chat.postMessage({ channel: ch, text: mgrText });
      } catch (e) {
        console.error('forgot-clockout manager DM failed:', e);
      }
    }
  }
}
