import { App } from '@slack/bolt';
import { db } from '../db';
import { config } from '../config';
import {
  clearScheduleRange, clearAllSchedules,
  insertScheduleEntry, insertDayOffEntry
} from '../services/schedule';

/**
 * /horario-import opens a modal where the manager pastes JSON exported from
 * the planner HTML or a Homebase PDF extraction.
 *
 * Expected JSON shape:
 *   {
 *     "range": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" },   // optional, for partial replace
 *     "entries": [
 *       { "date": "2026-04-13", "planner_id": 4, "dept": "L1", "shift_id": "M",
 *         "custom_start_hour": 8, "custom_end_hour": 14, "note": "salió temprano" },
 *       ...
 *     ],
 *     "days_off": [
 *       { "date": "2026-04-13", "planner_id": 8, "reason": "time_off" },
 *       ...
 *     ]
 *   }
 *
 * If `range` is provided, only entries inside [start, end] are wiped before insert
 * (allows month-by-month refresh). Without `range`, ALL schedule data is wiped.
 */
export function registerHorarioImport(app: App) {
  app.command('/horario-import', async ({ ack, body, client, respond }) => {
    await ack();
    const userId = (body as any).user_id;
    if (!config.managerSlackIds.includes(userId) && !config.adminSlackIds.includes(userId)) {
      await respond({ response_type: 'ephemeral', text: '❌ Solo manager/admin pueden importar horarios.' });
      return;
    }
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'horario_import_submit',
        title: { type: 'plain_text', text: 'Importar horarios' },
        submit: { type: 'plain_text', text: 'Importar' },
        close: { type: 'plain_text', text: 'Cancelar' },
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: 'Pega el JSON con `entries` y `days_off`.\nSi incluye `range`, sólo se reemplazan esas fechas. Sin `range` se borra TODO.' }
          },
          {
            type: 'input',
            block_id: 'json_block',
            label: { type: 'plain_text', text: 'JSON' },
            element: { type: 'plain_text_input', action_id: 'json_input', multiline: true }
          }
        ]
      }
    });
  });

  app.view('horario_import_submit', async ({ ack, view, client, body }) => {
    const userId = (body as any).user?.id;
    if (!config.managerSlackIds.includes(userId) && !config.adminSlackIds.includes(userId)) {
      await ack({ response_action: 'errors', errors: { json_block: 'Solo manager/admin pueden importar.' } });
      return;
    }
    const raw = view.state.values.json_block.json_input.value || '';
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      await ack({ response_action: 'errors', errors: { json_block: 'JSON inválido' } });
      return;
    }
    if (!Array.isArray(data.entries)) {
      await ack({ response_action: 'errors', errors: { json_block: 'Falta el array `entries`' } });
      return;
    }
    if (data.days_off && !Array.isArray(data.days_off)) {
      await ack({ response_action: 'errors', errors: { json_block: '`days_off` debe ser array' } });
      return;
    }

    await ack();

    let schedCount = 0, doCount = 0;
    let rangeMsg = '';
    const tx = db.transaction(() => {
      if (data.range?.start && data.range?.end) {
        clearScheduleRange(data.range.start, data.range.end);
        rangeMsg = ` en rango ${data.range.start} → ${data.range.end}`;
      } else {
        clearAllSchedules();
        rangeMsg = ' (TODO el calendario)';
      }
      for (const e of data.entries as any[]) {
        if (!e.date || !e.dept || !e.shift_id || typeof e.planner_id !== 'number') continue;
        insertScheduleEntry({
          date: e.date,
          dept: e.dept,
          shiftId: e.shift_id,
          plannerId: e.planner_id,
          customStartHour: typeof e.custom_start_hour === 'number' ? e.custom_start_hour : null,
          customEndHour: typeof e.custom_end_hour === 'number' ? e.custom_end_hour : null,
          note: e.note ?? null,
          source: e.source ?? 'import'
        });
        schedCount++;
      }
      if (Array.isArray(data.days_off)) {
        for (const d of data.days_off) {
          if (!d.date || typeof d.planner_id !== 'number') continue;
          insertDayOffEntry(d.planner_id, d.date, d.reason ?? null);
          doCount++;
        }
      }
    });
    tx();

    try {
      await client.chat.postMessage({
        channel: body.user.id,
        text: `✅ Importación${rangeMsg}: ${schedCount} turnos · ${doCount} días libres.`
      });
    } catch { /* ignore */ }
  });
}
