import { ShiftDef } from '../config';
import type { ShiftState } from '../services/punches';
import { describeSnapshot, AssignmentSnapshot } from '../services/swaps';

export function punchButtonsBlocks(opts: {
  state: ShiftState;
  dept: string;
  shift: ShiftDef;
  shiftDate: string;
  startISO: string;
  endISO: string;
  lastPunch?: { type: string; ts: string; lateMin?: number; excessMin?: number } | null;
}) {
  const { state, dept, shift, shiftDate, startISO, endISO, lastPunch } = opts;
  const startEpoch = Math.floor(new Date(startISO).getTime() / 1000);
  const endEpoch = Math.floor(new Date(endISO).getTime() / 1000);

  // Confirmation dialog for Clock Out — prevents misclicks (e.g. agent meant
  // Break Out but hit Clock Out). NOTE: Slack confirm dialogs are static at
  // render time, so we avoid time-dependent text like "faltan X min" — that
  // would go stale once the user clicks the button later.
  const clockOutConfirmText = state === 'on_break'
    ? '⚠️ Estás en break. Vas a cerrar el turno, no salir de break. ¿Estás seguro?'
    : '¿Confirmás que querés cerrar tu turno?';
  const clockOutConfirm = {
    title:   { type: 'plain_text', text: 'Cerrar turno' },
    text:    { type: 'plain_text', text: clockOutConfirmText },
    confirm: { type: 'plain_text', text: 'Sí, cerrar' },
    deny:    { type: 'plain_text', text: 'Cancelar' }
  };

  const stateLabel = {
    off: '⚪ Sin marcar',
    in: '🟢 En turno',
    on_break: '🟠 En break',
    completed: '✅ Turno finalizado'
  }[state];

  const value = `${shiftDate}|${dept}|${shift.id}`;

  const buttons: any[] = [];
  if (state === 'off') {
    buttons.push({
      type: 'button', style: 'primary',
      text: { type: 'plain_text', text: 'Clock In' },
      action_id: 'punch_clock_in', value
    });
  }
  if (state === 'in') {
    buttons.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Break 30 min' },
      action_id: 'punch_break_in_30', value
    });
    buttons.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Break 1h' },
      action_id: 'punch_break_in_60', value
    });
    buttons.push({
      type: 'button', style: 'danger',
      text: { type: 'plain_text', text: 'Clock Out' },
      action_id: 'punch_clock_out', value,
      confirm: clockOutConfirm
    });
  }
  if (state === 'on_break') {
    buttons.push({
      type: 'button', style: 'primary',
      text: { type: 'plain_text', text: 'Break Out' },
      action_id: 'punch_break_out', value
    });
    buttons.push({
      type: 'button', style: 'danger',
      text: { type: 'plain_text', text: 'Clock Out' },
      action_id: 'punch_clock_out', value,
      confirm: clockOutConfirm
    });
  }
  // state === 'completed' → normalmente sin botones, PERO si el clock_out
  // se hizo hace <5 min, mostramos un botón para deshacer por si fue misclick.
  if (state === 'completed' && lastPunch && lastPunch.type === 'clock_out') {
    const lpMs = new Date(lastPunch.ts).getTime();
    const ageMin = (Date.now() - lpMs) / 60000;
    if (ageMin < 5) {
      buttons.push({
        type: 'button',
        text: { type: 'plain_text', text: '↩ Deshacer salida' },
        action_id: 'punch_undo_clock_out', value,
        confirm: {
          title:   { type: 'plain_text', text: 'Deshacer salida' },
          text:    { type: 'plain_text', text: 'Esto borra tu Clock Out reciente y te deja como estabas antes. ¿Continuar?' },
          confirm: { type: 'plain_text', text: 'Sí, deshacer' },
          deny:    { type: 'plain_text', text: 'Cancelar' }
        }
      });
    }
  }

  // Compose "última marca" line if we have a recent punch
  let lastLine = '';
  if (lastPunch) {
    const lpEpoch = Math.floor(new Date(lastPunch.ts).getTime() / 1000);
    const lpLabel: Record<string, string> = {
      clock_in: 'Clock In',
      break_in: 'Break In',
      break_out: 'Break Out',
      clock_out: 'Clock Out'
    };
    const action = lpLabel[lastPunch.type] || lastPunch.type;
    let suffix = '';
    if (lastPunch.lateMin && lastPunch.lateMin > 0) {
      suffix = ` · ⚠️ *+${lastPunch.lateMin} min de retraso*`;
    } else if (lastPunch.excessMin && lastPunch.excessMin > 0) {
      suffix = ` · ⚠️ *+${lastPunch.excessMin} min de exceso*`;
    }
    lastLine = `\n✓ Última marca: *${action}* · <!date^${lpEpoch}^{time}|${lastPunch.ts} UTC>${suffix}`;
  }

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Tu turno de hoy* — ${dept} ${shift.label}\n` +
              `🕐 <!date^${startEpoch}^{time}|${shift.startHour}:00 UTC> → <!date^${endEpoch}^{time}|${shift.endHour}:00 UTC>\n` +
              `Estado: ${stateLabel}` + lastLine
      }
    },
    ...(buttons.length ? [{ type: 'actions', elements: buttons }] : []),
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_Fecha: ${shiftDate} · Turno: ${shift.id}_` }]
    }
  ];
}

function fmtDateLong(iso: string): string {
  // iso = "YYYY-MM-DD"
  const dt = new Date(iso + 'T00:00:00Z');
  const days = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  return `${days[dt.getUTCDay()]} ${dt.getUTCDate()} ${months[dt.getUTCMonth()]}`;
}

export function swapPreviewSection(opts: {
  requesterSlackId: string;
  partnerSlackId: string;
  requesterDate: string;
  partnerDate: string;
  requesterSnapshot: AssignmentSnapshot;
  partnerSnapshot: AssignmentSnapshot;
  note: string | null;
}) {
  const lines = [
    `*<@${opts.requesterSlackId}>* entrega:`,
    `  • ${fmtDateLong(opts.requesterDate)} (${opts.requesterDate}) — ${describeSnapshot(opts.requesterSnapshot)}`,
    ``,
    `*<@${opts.partnerSlackId}>* entrega:`,
    `  • ${fmtDateLong(opts.partnerDate)} (${opts.partnerDate}) — ${describeSnapshot(opts.partnerSnapshot)}`,
  ];
  if (opts.note) {
    lines.push('', `_Nota:_ ${opts.note}`);
  }
  return { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } };
}

export function swapPartnerDMBlocks(opts: {
  swapId: number;
  requesterSlackId: string;
  partnerSlackId: string;
  requesterDate: string;
  partnerDate: string;
  requesterSnapshot: AssignmentSnapshot;
  partnerSnapshot: AssignmentSnapshot;
  note: string | null;
}) {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `🔁 *Solicitud de cambio de turno* de <@${opts.requesterSlackId}>` }
    },
    swapPreviewSection(opts),
    {
      type: 'actions',
      elements: [
        {
          type: 'button', style: 'primary',
          text: { type: 'plain_text', text: 'Aceptar' },
          action_id: 'swap_partner_accept',
          value: String(opts.swapId)
        },
        {
          type: 'button', style: 'danger',
          text: { type: 'plain_text', text: 'Rechazar' },
          action_id: 'swap_partner_reject',
          value: String(opts.swapId)
        }
      ]
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `_Solicitud #${opts.swapId} · pendiente de tu respuesta_` }] }
  ];
}

export function swapApproverDMBlocks(opts: {
  swapId: number;
  requesterSlackId: string;
  partnerSlackId: string;
  requesterDate: string;
  partnerDate: string;
  requesterSnapshot: AssignmentSnapshot;
  partnerSnapshot: AssignmentSnapshot;
  note: string | null;
}) {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `🔁 *Cambio de turno pendiente de aprobación*\n<@${opts.partnerSlackId}> aceptó la solicitud de <@${opts.requesterSlackId}>.` }
    },
    swapPreviewSection(opts),
    {
      type: 'actions',
      elements: [
        {
          type: 'button', style: 'primary',
          text: { type: 'plain_text', text: 'Aprobar' },
          action_id: 'swap_approve',
          value: String(opts.swapId)
        },
        {
          type: 'button', style: 'danger',
          text: { type: 'plain_text', text: 'Rechazar' },
          action_id: 'swap_reject',
          value: String(opts.swapId)
        }
      ]
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `_Solicitud #${opts.swapId}_` }] }
  ];
}

export function swapResolvedBlocks(opts: {
  swapId: number;
  status: 'approved' | 'rejected_partner' | 'rejected_approver' | 'cancelled';
  requesterSlackId: string;
  partnerSlackId: string;
  requesterDate: string;
  partnerDate: string;
  requesterSnapshot: AssignmentSnapshot;
  partnerSnapshot: AssignmentSnapshot;
  note: string | null;
  resolverSlackId?: string | null;
  reason?: string | null;
}) {
  const headers: Record<string, string> = {
    approved: '✅ Cambio de turno aprobado y aplicado',
    rejected_partner: '❌ Solicitud rechazada por el compañero',
    rejected_approver: '❌ Solicitud rechazada por el aprobador',
    cancelled: '⚠️ Solicitud cancelada'
  };
  const blocks: any[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `*${headers[opts.status]}*` } },
    swapPreviewSection(opts)
  ];
  const ctx: string[] = [`Solicitud #${opts.swapId}`];
  if (opts.resolverSlackId) ctx.push(`por <@${opts.resolverSlackId}>`);
  if (opts.reason) ctx.push(`_${opts.reason}_`);
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: ctx.join(' · ') }] });
  return blocks;
}

// ─── Time-off (permisos / vacaciones) ────────────────────────────

function timeOffSummary(opts: {
  type: string; startDate: string; endDate: string; reason?: string | null;
}): string {
  const range = opts.startDate === opts.endDate
    ? opts.startDate
    : `${opts.startDate} → ${opts.endDate}`;
  const tipo = opts.type === 'vacaciones' ? '🏖️ Vacaciones' : '📝 Permiso';
  const days = Math.round(
    (new Date(opts.endDate).getTime() - new Date(opts.startDate).getTime()) / 86400000
  ) + 1;
  return `*${tipo}* · ${range} · ${days} dia${days === 1 ? '' : 's'}${opts.reason ? `\n_motivo:_ ${opts.reason}` : ''}`;
}

export function timeOffApproverBlocks(opts: {
  requestId: number;
  requesterName: string;
  requesterSlackId: string;
  type: string;
  startDate: string;
  endDate: string;
  reason?: string | null;
}) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Nueva solicitud de <@${opts.requesterSlackId}>*\n${timeOffSummary(opts)}`
      }
    },
    {
      type: 'actions',
      block_id: `time_off_${opts.requestId}`,
      elements: [
        {
          type: 'button', style: 'primary',
          text: { type: 'plain_text', text: '✅ Aprobar' },
          action_id: 'time_off_approve',
          value: String(opts.requestId)
        },
        {
          type: 'button', style: 'danger',
          text: { type: 'plain_text', text: '❌ Rechazar' },
          action_id: 'time_off_reject',
          value: String(opts.requestId)
        }
      ]
    }
  ];
}

export function timeOffRequesterBlocks(opts: {
  type: string; startDate: string; endDate: string; reason?: string | null;
}) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `📨 *Solicitud enviada*\n${timeOffSummary(opts)}\n\n_Te avisamos cuando un manager la revise._`
      }
    }
  ];
}

export function timeOffResolvedBlocks(opts: {
  type: string; startDate: string; endDate: string; reason?: string | null;
  status: 'approved' | 'rejected' | 'cancelled';
  approverSlackId?: string | null;
  rejectionReason?: string | null;
  audience: 'requester' | 'approver';
  requesterSlackId?: string;
}) {
  const verb = {
    approved: '✅ *Aprobada*',
    rejected: '❌ *Rechazada*',
    cancelled: '🚫 *Cancelada*'
  }[opts.status];

  const who = opts.approverSlackId ? ` por <@${opts.approverSlackId}>` : '';
  const rej = opts.rejectionReason ? `\n_motivo del rechazo:_ ${opts.rejectionReason}` : '';
  const reqLine = opts.audience === 'approver' && opts.requesterSlackId
    ? `*Solicitud de <@${opts.requesterSlackId}>*\n`
    : '';

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${reqLine}${verb}${who}\n${timeOffSummary(opts)}${rej}`
      }
    }
  ];
}

export function timeOffModalView() {
  return {
    type: 'modal' as const,
    callback_id: 'time_off_submit',
    title: { type: 'plain_text' as const, text: 'Solicitar tiempo libre' },
    submit: { type: 'plain_text' as const, text: 'Enviar' },
    close: { type: 'plain_text' as const, text: 'Cancelar' },
    blocks: [
      {
        type: 'input',
        block_id: 'type',
        label: { type: 'plain_text', text: 'Tipo' },
        element: {
          type: 'static_select',
          action_id: 'v',
          placeholder: { type: 'plain_text', text: 'Selecciona' },
          options: [
            { text: { type: 'plain_text', text: '📝 Permiso' }, value: 'permiso' },
            { text: { type: 'plain_text', text: '🏖️ Vacaciones' }, value: 'vacaciones' }
          ]
        }
      },
      {
        type: 'input',
        block_id: 'start_date',
        label: { type: 'plain_text', text: 'Fecha inicio' },
        element: { type: 'datepicker', action_id: 'v' }
      },
      {
        type: 'input',
        block_id: 'end_date',
        label: { type: 'plain_text', text: 'Fecha fin (igual al inicio si es un solo dia)' },
        element: { type: 'datepicker', action_id: 'v' }
      },
      {
        type: 'input',
        block_id: 'reason',
        optional: true,
        label: { type: 'plain_text', text: 'Motivo (opcional)' },
        element: {
          type: 'plain_text_input', action_id: 'v', multiline: true,
          placeholder: { type: 'plain_text', text: 'Ej: cita medica, viaje familiar...' }
        }
      }
    ]
  };
}

export function attendancePostBlocks(opts: {
  agentName: string; type: string; ts: string; dept: string; shiftId: string;
  excessMin?: number;
  lateMin?: number;
}) {
  const emoji = {
    clock_in: '🟢',
    clock_out: '🔴',
    break_in: '☕',
    break_out: '🔄'
  }[opts.type] || '•';
  const action = {
    clock_in: 'marcó entrada',
    clock_out: 'marcó salida',
    break_in: 'comenzó break',
    break_out: 'regresó del break'
  }[opts.type] || opts.type;
  const epoch = Math.floor(new Date(opts.ts).getTime() / 1000);
  let suffix = '';
  if (opts.lateMin && opts.lateMin > 0) suffix = ` · ⚠️ *+${opts.lateMin} min de retraso*`;
  else if (opts.excessMin && opts.excessMin > 0) suffix = ` · ⚠️ *+${opts.excessMin} min de exceso*`;
  return [{
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `${emoji} *${opts.agentName}* ${action} · ${opts.dept} ${opts.shiftId} · <!date^${epoch}^{time}|${opts.ts} UTC>${suffix}`
    }]
  }];
}
