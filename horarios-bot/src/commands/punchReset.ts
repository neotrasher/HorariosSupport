import { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import { config } from '../config';
import { clearPunchesForDate } from '../services/punches';
import { db } from '../db';

/**
 * /punch-reset                       → wipe today's punches for self
 * /punch-reset @user                 → wipe today's punches for that user
 * /punch-reset @user 2026-04-29      → wipe punches for that user on that date
 * Manager-only. Useful for re-running tests.
 */
export function registerPunchReset(app: App) {
  app.command('/punch-reset', async ({ ack, command, respond }) => {
    await ack();

    if (!config.managerSlackIds.includes(command.user_id)) {
      await respond({ response_type: 'ephemeral', text: '❌ Solo managers.' });
      return;
    }

    const parts = (command.text || '').trim().split(/\s+/).filter(Boolean);
    let targetUserId = command.user_id;
    let dateArg: string | null = null;

    for (const p of parts) {
      const m = p.match(/^<@([A-Z0-9]+)(?:\|[^>]+)?>$/);
      if (m) targetUserId = m[1];
      else if (/^\d{4}-\d{2}-\d{2}$/.test(p)) dateArg = p;
    }

    const dateStr = dateArg || DateTime.utc().toFormat('yyyy-LL-dd');

    // Also wipe shift_messages for that day so a new test sends a fresh DM
    db.prepare(`
      DELETE FROM shift_messages WHERE slack_id = ? AND shift_date = ?
    `).run(targetUserId, dateStr);

    db.prepare(`
      DELETE FROM alerts_sent WHERE slack_id = ? AND shift_date = ?
    `).run(targetUserId, dateStr);

    const removed = clearPunchesForDate(targetUserId, dateStr);

    const who = targetUserId === command.user_id ? 'tus' : `de <@${targetUserId}>`;
    await respond({
      response_type: 'ephemeral',
      text: `🧹 ${removed} marcas ${who} eliminadas para ${dateStr}. ` +
            `Mensajes de turno y alertas también limpiadas. Listo para retestear.`
    });
  });
}
