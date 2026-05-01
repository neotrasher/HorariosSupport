import { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import { config } from '../config';
import { getAllShiftsForDate, shiftWindow } from '../services/schedule';
import { getAgentByPlannerId } from '../services/agents';
import { getShiftState, alertAlreadySent, markAlertSent } from '../services/punches';

/**
 * Runs every minute. If an agent's shift started more than `LATE_THRESHOLD_MIN`
 * minutes ago and there's no clock_in, DM the agent and the managers.
 */
export async function runLateChecker(app: App) {
  const now = DateTime.utc();
  const today = now.startOf('day');
  const yesterday = today.minus({ days: 1 });

  const candidates = [
    ...getAllShiftsForDate(today).map(s => ({ ...s, baseDate: today })),
    ...getAllShiftsForDate(yesterday)
      .filter(s => s.endHour > 24)
      .map(s => ({ ...s, baseDate: yesterday }))
  ];

  for (const c of candidates) {
    const w = shiftWindow(c.baseDate, c);
    const lateMin = now.diff(w.start, 'minutes').minutes;
    if (lateMin < config.lateThresholdMin) continue;
    if (now > w.end) continue; // shift already ended; skip

    const agent = getAgentByPlannerId(c.planner_id);
    if (!agent) continue;

    const shiftDate = c.baseDate.toFormat('yyyy-LL-dd');
    // Shift-scoped state — robust to clock-ins recorded a few minutes BEFORE midnight
    // (00:00 UTC shifts often have ts in the previous UTC day).
    const state = getShiftState(agent.slack_id, shiftDate, c.shift.id);
    if (state !== 'off') continue;

    if (alertAlreadySent(agent.slack_id, shiftDate, c.shift.id, 'late')) continue;

    const startStr = w.start.toFormat('HH:mm');
    const lateRound = Math.round(lateMin);

    // DM agent
    try {
      const im = await app.client.conversations.open({ users: agent.slack_id });
      if (im.channel?.id) {
        await app.client.chat.postMessage({
          channel: im.channel.id,
          text: `⚠️ Tu turno ${c.dept} ${c.shift.label} comenzó a las ${startStr} UTC y aún no has marcado entrada (${lateRound}m tarde). ¿Todo bien?`
        });
      }
    } catch (e) {
      console.error('late DM agent failed:', e);
    }

    // DM managers
    for (const mgrId of config.managerSlackIds) {
      try {
        const im = await app.client.conversations.open({ users: mgrId });
        if (im.channel?.id) {
          await app.client.chat.postMessage({
            channel: im.channel.id,
            text: `🔴 *${agent.name}* (<@${agent.slack_id}>) no ha marcado entrada · ${c.dept} ${c.shift.label} ${startStr} UTC · ${lateRound}m tarde`
          });
        }
      } catch (e) {
        console.error('late DM manager failed:', e);
      }
    }

    markAlertSent(agent.slack_id, shiftDate, c.shift.id, 'late');
  }
}
