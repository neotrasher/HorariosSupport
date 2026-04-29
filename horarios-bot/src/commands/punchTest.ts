import { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import { config, SHIFTS } from '../config';
import { punchButtonsBlocks } from '../ui/blocks';
import { getShiftState, setShiftMessage } from '../services/punches';

/**
 * /punch-test                       → DM to self with L1.T buttons for today (UTC)
 * /punch-test @user                 → DM to that user with L1.T buttons for today
 * /punch-test @user L2 N            → DM to that user with L2.N buttons for today
 * /punch-test @user L1 T 2026-04-29 → DM to that user with L1.T buttons for that date
 * /punch-test L2 N                  → DM to self with L2.N buttons for today
 * Manager-only.
 */
export function registerPunchTest(app: App) {
  app.command('/punch-test', async ({ ack, command, client, respond }) => {
    await ack();

    if (!config.managerSlackIds.includes(command.user_id)) {
      await respond({ response_type: 'ephemeral', text: '❌ Solo managers.' });
      return;
    }

    let parts = (command.text || '').trim().split(/\s+/).filter(Boolean);

    // Optional first arg: @user mention
    let targetUserId = command.user_id;
    if (parts[0]) {
      const mention = parts[0].match(/^<@([A-Z0-9]+)(?:\|[^>]+)?>$/);
      if (mention) {
        targetUserId = mention[1];
        parts = parts.slice(1);
      }
    }

    const dept = (parts[0] || 'L1').toUpperCase();
    const shiftId = (parts[1] || 'T').toUpperCase();
    const dateStr = parts[2] || DateTime.utc().toFormat('yyyy-LL-dd');

    const shift = SHIFTS[dept]?.[shiftId];
    if (!shift) {
      await respond({
        response_type: 'ephemeral',
        text: `❌ Combinación inválida. Usa: \`/punch-test [L1|L2] [M|T|E|N] [YYYY-MM-DD]\``
      });
      return;
    }

    const date = DateTime.fromISO(dateStr, { zone: 'utc' });
    const start = date.startOf('day').plus({ hours: shift.startHour });
    const end = date.startOf('day').plus({ hours: shift.endHour });
    const state = getShiftState(targetUserId, dateStr, shift.id);

    const blocks = punchButtonsBlocks({
      state,
      dept, shift, shiftDate: dateStr,
      startISO: start.toISO()!,
      endISO: end.toISO()!
    });

    try {
      const im = await client.conversations.open({ users: targetUserId });
      const ch = im.channel?.id;
      if (!ch) throw new Error('cannot open IM');
      const res = await client.chat.postMessage({
        channel: ch,
        text: `🧪 TEST · Turno simulado — ${dept} ${shift.label}`,
        blocks
      });
      if (res.ts) setShiftMessage(targetUserId, dateStr, shift.id, ch, res.ts);
      const target = targetUserId === command.user_id ? 'a ti mismo' : `a <@${targetUserId}>`;
      await respond({
        response_type: 'ephemeral',
        text: `✅ DM de prueba enviado ${target} · ${dept} ${shift.label} ${dateStr} (${shift.startHour}:00–${shift.endHour}:00 UTC)`
      });
    } catch (e: any) {
      await respond({
        response_type: 'ephemeral',
        text: `❌ Error enviando DM: ${e?.data?.error || e?.message || 'desconocido'}`
      });
    }
  });
}
