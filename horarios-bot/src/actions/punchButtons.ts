import { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import { config, SHIFTS } from '../config';
import {
  recordPunch, getShiftState, PunchType,
  lastBreakInWithDur, lastPunchId, updatePunchNote, lastPunchForShift,
  deletePunchById
} from '../services/punches';
import { logAudit } from '../services/audit';
import { getAgentBySlackId } from '../services/agents';
import { findScheduleEntry } from '../services/schedule';
import { punchButtonsBlocks, attendancePostBlocks } from '../ui/blocks';

const ACTION_TO_TYPE: Record<string, PunchType> = {
  punch_clock_in: 'clock_in',
  punch_clock_out: 'clock_out',
  punch_break_in_30: 'break_in',
  punch_break_in_60: 'break_in',
  punch_break_in: 'break_in', // legacy fallback for any older DM message
  punch_break_out: 'break_out'
};

/** Extract the chosen break duration from the action_id. Default 60 for legacy. */
function durMinFromActionId(actionId: string): number {
  if (actionId === 'punch_break_in_30') return 30;
  if (actionId === 'punch_break_in_60') return 60;
  return 60; // legacy `punch_break_in`
}

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

      // Rule 0 (#3a): block if the actor has no schedule_entry for this date+dept+shift.
      // Buttons are normally only sent to agents with a shift, but this guards
      // against stale messages or unauthorized clicks.
      const agent = getAgentBySlackId(slackId);
      if (!agent) {
        try {
          await client.chat.postEphemeral({
            channel: (body as any).channel?.id || slackId,
            user: slackId,
            text: '❌ Tu cuenta no esta vinculada a un agente. Pide a un manager que use `/horario-link`.'
          });
        } catch { /* ignore */ }
        return;
      }
      const scheduled = findScheduleEntry(agent.planner_id, shiftDate);
      if (!scheduled || scheduled.dept !== dept || scheduled.shift_id !== shiftId) {
        try {
          await client.chat.postEphemeral({
            channel: (body as any).channel?.id || slackId,
            user: slackId,
            text: `❌ No tienes turno asignado para ${dept}.${shiftId} el ${shiftDate}. Si crees que es un error, avisa a un manager.`
          });
        } catch { /* ignore */ }
        return;
      }

      const date = DateTime.fromISO(shiftDate, { zone: 'utc' });
      const start = date.startOf('day').plus({ hours: shift.startHour });
      const end = date.startOf('day').plus({ hours: shift.endHour });

      // Determine break duration if it's a break_in (30 or 60). 0 otherwise.
      const breakDur = type === 'break_in' ? durMinFromActionId(actionId) : 0;

      // Rule 1: block Break In if not enough time left for the chosen duration
      if (type === 'break_in') {
        const minsToEnd = end.diff(now, 'minutes').minutes;
        if (minsToEnd <= breakDur) {
          const msg = `❌ No alcanza para un break de ${breakDur} min: faltan ${Math.max(0, Math.round(minsToEnd))} min para terminar el turno.`;
          try {
            await client.chat.postEphemeral({
              channel: (body as any).channel?.id || slackId,
              user: slackId,
              text: msg
            });
          } catch {
            try {
              await client.chat.postMessage({ channel: slackId, text: msg });
            } catch { /* ignore */ }
          }
          return;
        }
      }

      // Record punch (encode break duration in note for break_in)
      recordPunch(slackId, type, {
        source: 'button', ts: now, shiftDate, shiftId,
        note: type === 'break_in' ? `dur=${breakDur}` : undefined
      });

      const grace = config.gracePeriodMin;

      // Rule 2: on Break Out, compute excess vs last break_in's chosen duration (apply grace)
      let excessMin = 0; // raw excess used internally for note
      let reportedExcessMin = 0; // what we surface to UI/manager (after grace)
      let breakDurUsed = 0; // duration of the break being closed (for messages)
      if (type === 'break_out') {
        const last = lastBreakInWithDur(slackId, shiftDate, shiftId);
        if (last) {
          const bi = DateTime.fromISO(last.ts, { zone: 'utc' });
          const elapsed = now.diff(bi, 'minutes').minutes;
          breakDurUsed = last.durMin;
          if (elapsed > last.durMin) {
            excessMin = Math.round(elapsed - last.durMin);
            const punchId = lastPunchId(slackId, shiftDate, shiftId, 'break_out');
            if (punchId) updatePunchNote(punchId, `exceso ${excessMin}m sobre ${last.durMin}m`);
            if (excessMin > grace) reportedExcessMin = excessMin;
          }
        }
      }

      // Rule 3: on Clock In, compute lateness vs shift start (with grace)
      let lateMin = 0;
      if (type === 'clock_in') {
        const delta = Math.round(now.diff(start, 'minutes').minutes);
        if (delta > grace) {
          lateMin = delta;
          const punchId = lastPunchId(slackId, shiftDate, shiftId, 'clock_in');
          if (punchId) updatePunchNote(punchId, `tarde ${lateMin}m`);
        }
      }

      // Update DM message with new per-shift state
      const newState = getShiftState(slackId, shiftDate, shiftId);
      const lp = lastPunchForShift(slackId, shiftDate, shiftId);
      const blocks = punchButtonsBlocks({
        state: newState,
        dept, shift, shiftDate,
        startISO: start.toISO()!,
        endISO: end.toISO()!,
        lastPunch: lp ? {
          type: lp.type,
          ts: lp.ts,
          lateMin: lp.type === 'clock_in' ? lateMin : 0,
          excessMin: lp.type === 'break_out' ? reportedExcessMin : 0
        } : null
      });
      try {
        await respond({
          replace_original: true,
          blocks,
          text: `Tu turno de hoy — ${dept} ${shift.label}`
        });
      } catch { /* message may have expired */ }

      // `agent` already resolved at top of handler (rule 0)

      // Post to attendance channel
      if (config.attendanceChannelId) {
        try {
          await client.chat.postMessage({
            channel: config.attendanceChannelId,
            text: `${agent?.name || slackId} · ${type}${reportedExcessMin ? ` (+${reportedExcessMin}m exceso)` : ''}${lateMin ? ` (+${lateMin}m tarde)` : ''}`,
            blocks: attendancePostBlocks({
              agentName: agent?.name || `<@${slackId}>`,
              type,
              ts: now.toISO()!,
              dept,
              shiftId,
              excessMin: reportedExcessMin || undefined,
              lateMin: lateMin || undefined
            })
          });
        } catch (e) {
          console.error('Failed to post to attendance channel:', e);
        }
      }

      // DM managers (and admins) if break exceeded grace OR clock-in late
      const notifyTargets = Array.from(new Set([
        ...config.managerSlackIds,
        ...config.adminSlackIds
      ]));

      if (reportedExcessMin > 0) {
        const durLbl = breakDurUsed === 30 ? '30 min' : '1h';
        const text = `⚠️ *${agent?.name || `<@${slackId}>`}* regresó del break (${durLbl}) con *${reportedExcessMin} min de exceso* · ${dept} ${shift.label} · ${shiftDate}`;
        for (const mgrId of notifyTargets) {
          try {
            const im = await client.conversations.open({ users: mgrId });
            const ch = (im as any).channel?.id;
            if (ch) await client.chat.postMessage({ channel: ch, text });
          } catch (e) {
            console.error('break excess DM to manager failed:', e);
          }
        }
      }

      if (lateMin > 0) {
        const startStr = `${String(shift.startHour).padStart(2, '0')}:00`;
        const markedStr = now.toFormat('HH:mm');
        const text = `⚠️ *${agent?.name || `<@${slackId}>`}* marcó entrada con *+${lateMin} min de retraso*\nTurno: ${dept} ${shift.label} · ${shiftDate} · esperado ${startStr} UTC · marcó ${markedStr} UTC`;
        for (const mgrId of notifyTargets) {
          try {
            const im = await client.conversations.open({ users: mgrId });
            const ch = (im as any).channel?.id;
            if (ch) await client.chat.postMessage({ channel: ch, text });
          } catch (e) {
            console.error('late clock-in DM to manager failed:', e);
          }
        }
      }
    });
  }

  // ── Undo clock_out (5-min window) ────────────────────────────────────
  app.action('punch_undo_clock_out', async ({ ack, body, action, client, respond }) => {
    await ack();
    const slackId = (body as any).user?.id;
    const value = (action as any).value as string;
    if (!value || !slackId) return;
    const [shiftDate, dept, shiftId] = value.split('|');
    const shift = SHIFTS[dept]?.[shiftId];
    if (!shift) return;

    const agent = getAgentBySlackId(slackId);
    if (!agent) return;

    // Find the most recent clock_out punch for this shift and verify <5 min old
    const punchId = lastPunchId(slackId, shiftDate, shiftId, 'clock_out');
    if (!punchId) {
      try {
        await client.chat.postEphemeral({
          channel: (body as any).channel?.id || slackId,
          user: slackId,
          text: '❌ No encontré un Clock Out reciente para deshacer.'
        });
      } catch {}
      return;
    }
    const lp = lastPunchForShift(slackId, shiftDate, shiftId);
    if (!lp || lp.type !== 'clock_out') return;
    const ageMin = (Date.now() - new Date(lp.ts).getTime()) / 60000;
    if (ageMin > 5) {
      try {
        await client.chat.postEphemeral({
          channel: (body as any).channel?.id || slackId,
          user: slackId,
          text: '⏰ El plazo para deshacer (5 min) ya pasó. Pedile a un manager que use `/punch-fix`.'
        });
      } catch {}
      return;
    }

    deletePunchById(punchId);
    logAudit({
      actorSlackId: slackId, actorName: agent.name,
      action: 'punch.undo_clock_out',
      targetKind: 'punch', targetId: String(punchId),
      summary: `Deshizo Clock Out propio (${dept}.${shiftId} · ${shiftDate}) dentro del plazo de 5 min`,
      payload: { punchId, shiftDate, dept, shiftId, ageMin: Math.round(ageMin) }
    });

    // Re-render DM with restored state
    const now = DateTime.utc();
    const baseDate = DateTime.fromISO(shiftDate, { zone: 'utc' });
    const start = baseDate.startOf('day').plus({ hours: shift.startHour });
    const end   = baseDate.startOf('day').plus({ hours: shift.endHour });
    const newState = getShiftState(slackId, shiftDate, shiftId);
    const lpAfter = lastPunchForShift(slackId, shiftDate, shiftId);
    const blocks = punchButtonsBlocks({
      state: newState,
      dept, shift, shiftDate,
      startISO: start.toISO()!,
      endISO: end.toISO()!,
      lastPunch: lpAfter ? { type: lpAfter.type, ts: lpAfter.ts } : null
    });
    try {
      await respond({
        replace_original: true,
        blocks,
        text: `Tu turno de hoy — ${dept} ${shift.label}`
      });
    } catch {}
    try {
      await client.chat.postEphemeral({
        channel: (body as any).channel?.id || slackId,
        user: slackId,
        text: '↩ Clock Out deshecho. Volviste al estado anterior.'
      });
    } catch {}
  });
}
