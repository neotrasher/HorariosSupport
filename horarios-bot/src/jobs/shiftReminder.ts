import { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import { config } from '../config';
import { getAllShiftsForDate, shiftWindow } from '../services/schedule';
import { getAgentByPlannerId } from '../services/agents';
import {
  getShiftState, alertAlreadySent, markAlertSent, setShiftMessage
} from '../services/punches';
import { punchButtonsBlocks } from '../ui/blocks';

/**
 * Runs every minute. For each scheduled shift starting in `REMINDER_LEAD_MIN`,
 * sends a DM to the agent with the punch buttons.
 */
export async function runShiftReminder(app: App) {
  const now = DateTime.utc();
  const today = now.startOf('day');
  const yesterday = today.minus({ days: 1 });
  const tomorrow = today.plus({ days: 1 });

  const candidates = [
    ...getAllShiftsForDate(today).map(s => ({ ...s, baseDate: today })),
    ...getAllShiftsForDate(yesterday)
      .filter(s => s.endHour > 24)
      .map(s => ({ ...s, baseDate: yesterday })),
    // Tomorrow's shifts starting just past midnight need to be considered when
    // the cron runs in the last minutes of TODAY (e.g. 23:55 → tomorrow 00:00).
    ...getAllShiftsForDate(tomorrow).map(s => ({ ...s, baseDate: tomorrow }))
  ];

  for (const c of candidates) {
    const w = shiftWindow(c.baseDate, c);
    const minsUntilStart = w.start.diff(now, 'minutes').minutes;
    // Fire if shift starts within next reminderLeadMin minutes; allow 1 min of
    // overshoot to recover from a missed cron tick (idempotency prevents dupes).
    if (minsUntilStart < -1 || minsUntilStart > config.reminderLeadMin + 1) continue;

    const agent = getAgentByPlannerId(c.planner_id);
    if (!agent) continue;

    const shiftDate = c.baseDate.toFormat('yyyy-LL-dd');
    if (alertAlreadySent(agent.slack_id, shiftDate, c.shift.id, 'reminder')) continue;

    const state = getShiftState(agent.slack_id, shiftDate, c.shift.id);
    const blocks = punchButtonsBlocks({
      state,
      dept: c.dept,
      shift: c.shift,
      shiftDate,
      startISO: w.start.toISO()!,
      endISO: w.end.toISO()!
    });

    try {
      const im = await app.client.conversations.open({ users: agent.slack_id });
      const channel = im.channel?.id;
      if (!channel) continue;
      const res = await app.client.chat.postMessage({
        channel,
        text: `Tu turno empieza en ${Math.round(minsUntilStart)}m — ${c.dept} ${c.shift.label}`,
        blocks
      });
      if (res.ts) setShiftMessage(agent.slack_id, shiftDate, c.shift.id, channel, res.ts);
      markAlertSent(agent.slack_id, shiftDate, c.shift.id, 'reminder');
    } catch (e) {
      console.error('shiftReminder DM failed:', e);
    }
  }
}
