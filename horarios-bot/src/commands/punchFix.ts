import { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import { config } from '../config';
import { recordPunch, PunchType } from '../services/punches';

/**
 * /punch-fix @user clock_in 2026-04-28T09:00 [note]
 * Manager-only command to insert a corrected punch.
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

    recordPunch(slackId, typeRaw as PunchType, { source: 'manual', ts, note });
    await respond({
      response_type: 'ephemeral',
      text: `✅ Punch registrado: <@${slackId}> · ${typeRaw} · ${ts.toFormat('yyyy-LL-dd HH:mm')} UTC${note ? ` · _${note}_` : ''}`
    });
  });
}
