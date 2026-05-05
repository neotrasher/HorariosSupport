import { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import { config } from '../config';
import {
  listAgentsOnBreak, alertAlreadySent, markAlertSent
} from '../services/punches';
import { getAgentBySlackId } from '../services/agents';

/**
 * Runs every minute. For each agent currently on break with break_in > BREAK_MAX_MIN
 * minutes ago and no Break Out yet, DM the agent + DM all managers (once per shift).
 */
export async function runBreakOverdueChecker(app: App) {
  const now = DateTime.utc();
  const onBreak = listAgentsOnBreak();

  for (const b of onBreak) {
    const breakIn = DateTime.fromISO(b.break_in_ts, { zone: 'utc' });
    const elapsed = now.diff(breakIn, 'minutes').minutes;
    const limit = b.dur_min || 60; // duration chosen at break-in time
    if (elapsed < limit) continue;
    if (alertAlreadySent(b.slack_id, b.shift_date, b.shift_id, 'break_overdue')) continue;

    const agent = getAgentBySlackId(b.slack_id);
    const overMin = Math.round(elapsed - limit);
    const durLbl = limit === 30 ? '30 min' : '1h';

    // DM agent
    try {
      const im = await app.client.conversations.open({ users: b.slack_id });
      const ch = (im as any).channel?.id;
      if (ch) {
        await app.client.chat.postMessage({
          channel: ch,
          text: `⏰ Llevas más de ${durLbl} en break (${overMin} min de exceso). Marca *Break Out* cuando regreses.`
        });
      }
    } catch (e) {
      console.error('break overdue agent DM failed:', e);
    }

    // DM managers + admins
    const notifyTargets = Array.from(new Set([
      ...config.managerSlackIds,
      ...config.adminSlackIds
    ]));
    const mgrText = `⚠️ *${agent?.name || `<@${b.slack_id}>`}* lleva *${Math.round(elapsed)} min* en break (eligió ${durLbl} · ${overMin} min de exceso) · turno ${b.shift_date} ${b.shift_id}`;
    for (const mgrId of notifyTargets) {
      try {
        const im = await app.client.conversations.open({ users: mgrId });
        const ch = (im as any).channel?.id;
        if (ch) await app.client.chat.postMessage({ channel: ch, text: mgrText });
      } catch (e) {
        console.error('break overdue manager DM failed:', e);
      }
    }

    markAlertSent(b.slack_id, b.shift_date, b.shift_id, 'break_overdue');
  }
}
