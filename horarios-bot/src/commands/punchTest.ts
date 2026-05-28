import { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import { config, SHIFTS } from '../config';
import { db } from '../db';
import { punchButtonsBlocks } from '../ui/blocks';
import { getShiftState, setShiftMessage } from '../services/punches';
import { getAgentBySlackId } from '../services/agents';
import { insertScheduleEntry, findScheduleEntry } from '../services/schedule';
import { buildBreakInfoForDM } from '../services/breaks';

/**
 * /punch-test (manager-only)
 *
 * Modo legacy (sin keyword):
 *   /punch-test [@user] [L1|L2] [M|T|E|N] [YYYY-MM-DD]
 *     Manda un DM con los botones del turno. NO crea schedule_entry,
 *     así que el agente NO puede clickear los botones si no tiene turno real.
 *
 * Nuevos sub-comandos para probar la coordinación de breaks:
 *   /punch-test setup [@user] [dept] [shift] [date]
 *     Igual que el modo legacy, PERO si el agente no tiene schedule_entry
 *     real para esa fecha, crea uno temporal (source='test_break') para
 *     que los botones funcionen. Útil para probar el slot picker + cap.
 *
 *   /punch-test status
 *     Lista los test schedules activos.
 *
 *   /punch-test cleanup
 *     Borra todos los schedule_entries con source='test_break'.
 */
export function registerPunchTest(app: App) {
  app.command('/punch-test', async ({ ack, command, client, respond }) => {
    await ack();

    if (!config.managerSlackIds.includes(command.user_id)) {
      await respond({ response_type: 'ephemeral', text: '❌ Solo managers.' });
      return;
    }

    let parts = (command.text || '').trim().split(/\s+/).filter(Boolean);
    const firstWord = (parts[0] || '').toLowerCase();

    // ── cleanup ──────────────────────────────────────────────────────────
    if (firstWord === 'cleanup') {
      const r = db.prepare(`DELETE FROM schedule_entries WHERE source = 'test_break'`).run();
      // También limpia el shift_messages cache para los test entries (por si quedó algún DM apuntando)
      await respond({
        response_type: 'ephemeral',
        text: `🧹 Limpieza completa. Eliminados ${r.changes} schedule_entries de prueba.`
      });
      return;
    }

    // ── status ───────────────────────────────────────────────────────────
    if (firstWord === 'status') {
      const rows = db.prepare(`
        SELECT s.date, s.dept, s.shift_id, a.name, a.slack_id
          FROM schedule_entries s
          LEFT JOIN agents a ON a.planner_id = s.planner_id
         WHERE s.source = 'test_break'
         ORDER BY s.date, s.dept, s.shift_id, a.name
      `).all() as { date: string; dept: string; shift_id: string; name: string; slack_id: string }[];
      if (rows.length === 0) {
        await respond({ response_type: 'ephemeral', text: 'Sin test schedules activos. Usa `/punch-test setup …` para crear uno.' });
        return;
      }
      const lines = rows.map(r => `• ${r.date} — ${r.dept}.${r.shift_id} — ${r.name}`);
      await respond({
        response_type: 'ephemeral',
        text: `*${rows.length} test schedules activos:*\n${lines.join('\n')}\n\n_Usa \`/punch-test cleanup\` para borrarlos._`
      });
      return;
    }

    // ── help ─────────────────────────────────────────────────────────────
    if (firstWord === 'help' || firstWord === '?') {
      await respond({
        response_type: 'ephemeral',
        text:
          '*`/punch-test`* — manda DM de prueba con botones de turno\n' +
          '```\n' +
          '/punch-test                              → DM a ti, L1.T hoy (sin crear schedule)\n' +
          '/punch-test [@user] [L1|L2] [M|T|E|N] [date]\n' +
          '/punch-test setup [@user] [dept] [shift] [date]\n' +
          '    Como arriba pero crea schedule_entry temporal si no existe.\n' +
          '    Necesario para probar el slot picker y el cap de breaks.\n' +
          '/punch-test status     → lista test schedules activos\n' +
          '/punch-test cleanup    → borra todos los test schedules\n' +
          '```'
      });
      return;
    }

    // ── setup / legacy modes ─────────────────────────────────────────────
    const isSetup = firstWord === 'setup';
    if (isSetup) parts = parts.slice(1);

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
        text: `❌ Combinación inválida. Usa: \`/punch-test [setup] [@user] [L1|L2] [M|T|E|N] [YYYY-MM-DD]\``
      });
      return;
    }

    // En modo setup, asegurar que existe un schedule_entry
    let scheduleCreated = false;
    if (isSetup) {
      const agent = getAgentBySlackId(targetUserId);
      if (!agent) {
        await respond({
          response_type: 'ephemeral',
          text: `❌ <@${targetUserId}> no está vinculado como agente.`
        });
        return;
      }
      const existing = findScheduleEntry(agent.planner_id, dateStr);
      if (!existing) {
        insertScheduleEntry({
          date: dateStr, dept, shiftId,
          plannerId: agent.planner_id,
          source: 'test_break'
        });
        scheduleCreated = true;
      } else if (existing.dept !== dept || existing.shift_id !== shiftId) {
        await respond({
          response_type: 'ephemeral',
          text: `⚠️ ${agent.name} ya tiene un turno asignado el ${dateStr} (${existing.dept}.${existing.shift_id}). El DM se mandará pero el botón Clock In fallará si no coincide. Pide otra fecha o haz cleanup primero.`
        });
      }
    }

    const date = DateTime.fromISO(dateStr, { zone: 'utc' });
    const start = date.startOf('day').plus({ hours: shift.startHour });
    const end = date.startOf('day').plus({ hours: shift.endHour });
    const state = getShiftState(targetUserId, dateStr, shift.id);
    const breakInfo = config.breaksCoordinationEnabled && state === 'in'
      ? buildBreakInfoForDM({ slackId: targetUserId, dept, shiftId, shiftDate: dateStr })
      : null;

    const blocks = punchButtonsBlocks({
      state,
      dept, shift, shiftDate: dateStr,
      startISO: start.toISO()!,
      endISO: end.toISO()!,
      breakInfo
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
      const setupNote = scheduleCreated
        ? `\n📌 _Creé un schedule_entry temporal. Al terminar usa \`/punch-test cleanup\`._`
        : (isSetup ? '\n_(El schedule_entry ya existía, no creé uno nuevo.)_' : '');
      await respond({
        response_type: 'ephemeral',
        text: `✅ DM de prueba enviado ${target} · ${dept} ${shift.label} ${dateStr} (${shift.startHour}:00–${shift.endHour}:00 UTC)${setupNote}`
      });
    } catch (e: any) {
      await respond({
        response_type: 'ephemeral',
        text: `❌ Error enviando DM: ${e?.data?.error || e?.message || 'desconocido'}`
      });
    }
  });
}
