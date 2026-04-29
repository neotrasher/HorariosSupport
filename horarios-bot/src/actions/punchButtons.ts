import { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import { config, SHIFTS } from '../config';
import {
  recordPunch, getShiftState, PunchType,
  lastBreakInTs, lastPunchId, updatePunchNote
} from '../services/punches';
import { getAgentBySlackId } from '../services/agents';
import { punchButtonsBlocks, attendancePostBlocks } from '../ui/blocks';

const ACTION_TO_TYPE: Record<string, PunchType> = {
  punch_clock_in: 'clock_in',
  punch_clock_out: 'clock_out',
  punch_break_in: 'break_in',
  punch_break_out: 'break_out'
};

export function registerPunchButtons(app: App) {
  for (const actionId of Object.keys(ACTION_TO_TYPE)) {
    app.action(actionId, async ({ ack, body, action, client, respond }) => {
      await ack();
      const slackId = (body as any).user?.id;
      const value = (action as any).value as string; // shiftDate|dept|shiftId
      if (!value) return;
      const [shiftDate, dept, shiftId] = value.split('|');
      const shift = SHIFTS[dept]?.[shiftId];
      if (!shift) return;

      const type = ACTION_TO_TYPE[actionId];
      const now = DateTime.utc();

      const date = DateTime.fromISO(shiftDate, { zone: 'utc' });
      const start = date.startOf('day').plus({ hours: shift.startHour });
      const end = date.startOf('day').plus({ hours: shift.endHour });

      // Rule 1: block Break In within last hour of shift
      if (type === 'break_in') {
        const minsToEnd = end.diff(now, 'minutes').minutes;
        if (minsToEnd <= config.breakInLockoutMin) {
          try {
            await client.chat.postEphemeral({
              channel: (body as any).channel?.id || slackId,
              user: slackId,
              text: `❌ No se permite Break In en la última hora del turno (faltan ${Math.max(0, Math.round(minsToEnd))} min para terminar).`
            });
          } catch {
            try {
              await client.chat.postMessage({
                channel: slackId,
                text: `❌ No se permite Break In en la última hora del turno (faltan ${Math.max(0, Math.round(minsToEnd))} min).`
              });
            } catch { /* ignore */ }
          }
          return;
        }
      }

      // Record punch
      recordPunch(slackId, type, { source: 'button', ts: now, shiftDate, shiftId });

      // Rule 2: on Break Out, compute excess vs last break_in
      let excessMin = 0;
      if (type === 'break_out') {
        const biTs = lastBreakInTs(slackId, shiftDate, shiftId);
        if (biTs) {
          const bi = DateTime.fromISO(biTs, { zone: 'utc' });
          const elapsed = now.diff(bi, 'minutes').minutes;
          if (elapsed > config.breakMaxMin) {
            excessMin = Math.round(elapsed - config.breakMaxMin);
            const punchId = lastPunchId(slackId, shiftDate, shiftId, 'break_out');
            if (punchId) updatePunchNote(punchId, `exceso ${excessMin}m`);
          }
        }
      }

      // Update DM message with new per-shift state
      const newState = getShiftState(slackId, shiftDate, shiftId);
      const blocks = punchButtonsBlocks({
        state: newState,
        dept, shift, shiftDate,
        startISO: start.toISO()!,
        endISO: end.toISO()!
      });
      try {
        await respond({
          replace_original: true,
          blocks,
          text: `Tu turno de hoy — ${dept} ${shift.label}`
        });
      } catch { /* message may have expired */ }

      const agent = getAgentBySlackId(slackId);

      // Post to attendance channel
      if (config.attendanceChannelId) {
        try {
          await client.chat.postMessage({
            channel: config.attendanceChannelId,
            text: `${agent?.name || slackId} · ${type}${excessMin ? ` (+${excessMin}m)` : ''}`,
            blocks: attendancePostBlocks({
              agentName: agent?.name || `<@${slackId}>`,
              type,
              ts: now.toISO()!,
              dept,
              shiftId,
              excessMin: excessMin || undefined
            })
          });
        } catch (e) {
          console.error('Failed to post to attendance channel:', e);
        }
      }

      // DM managers if break exceeded
      if (excessMin > 0) {
        const text = `⚠️ *${agent?.name || `<@${slackId}>`}* regresó del break con *${excessMin} min de exceso* · ${dept} ${shift.label} · ${shiftDate}`;
        for (const mgrId of config.managerSlackIds) {
          try {
            const im = await client.conversations.open({ users: mgrId });
            const ch = (im as any).channel?.id;
            if (ch) await client.chat.postMessage({ channel: ch, text });
          } catch (e) {
            console.error('break excess DM to manager failed:', e);
          }
        }
      }
    });
  }
}
