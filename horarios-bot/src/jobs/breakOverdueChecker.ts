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
    if (elapsed < config.breakMaxMin) continue;
    if (alertAlreadySent(b.slack_id, b.shift_date, b.shift_id, 'break_overdue')) continue;

    const agent = getAgentBySlackId(b.slack_id);
    const overMin = Math.round(elapsed - config.breakMaxMin);

    // DM agent
    try {
      const im = await app.client.conversations.open({ users: b.slack_id });
      const ch = (im as any).channel?.id;
      if (ch) {
        await app.client.chat.postMessage({
          channel: ch,
          text: `⏰ Llevas más de ${config.breakMaxMin} min en break (${overMin} min de exceso). Marca *Break Out* cuando regreses.`
        });
      }
    } catch (e) {
      console.error('break overdue agent DM failed:', e);
    }

    // DM managers
    const mgrText = `⚠️ *${agent?.name || `<@${b.slack_id}>`}* lleva *${Math.round(elapsed)} min* en break (límite ${config.breakMaxMin} min · ${overMin} min de exceso) · turno ${b.shift_date} ${b.shift_id}`;
    for (const mgrId of config.managerSlackIds) {
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
