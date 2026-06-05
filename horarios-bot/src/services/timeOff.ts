import { DateTime } from 'luxon';
import { db } from '../db';
import { insertDayOffEntry, findScheduleEntry } from './schedule';
import { SHIFTS } from '../config';
import { getAgentBySlackId } from './agents';

export type TimeOffType = 'permiso' | 'vacaciones';
export type TimeOffStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export type TimeOffRequest = {
  id: number;
  requester_slack_id: string;
  type: TimeOffType;
  start_date: string;
  end_date: string;
  /** HH:mm formato 24h. Si null → día completo. Set → permiso fraccionario. */
  start_time: string | null;
  end_time: string | null;
  reason: string | null;
  status: TimeOffStatus;
  approver_slack_id: string | null;
  approval_at: string | null;
  rejection_reason: string | null;
  approval_dm_targets: string | null;
  requester_dm_channel: string | null;
  requester_dm_ts: string | null;
  created_at: string;
  source: string;
};

/** True si la solicitud cubre solo una fracción del día (no día completo). */
export function isPartialRequest(req: TimeOffRequest): boolean {
  return !!(req.start_time && req.end_time);
}

/** Parsea "HH:mm" → horas decimales (ej. "14:30" → 14.5). */
function parseHm(hm: string | null): number | null {
  if (!hm) return null;
  const m = hm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10), min = parseInt(m[2], 10);
  if (h < 0 || h > 24 || min < 0 || min > 59) return null;
  return h + min / 60;
}

export type DmTarget = { slack_id: string; channel: string; ts: string };

export function listDates(start: string, end: string): string[] {
  const s = DateTime.fromISO(start, { zone: 'utc' }).startOf('day');
  const e = DateTime.fromISO(end, { zone: 'utc' }).startOf('day');
  if (!s.isValid || !e.isValid || e < s) return [];
  const out: string[] = [];
  let cur = s;
  while (cur <= e) {
    out.push(cur.toFormat('yyyy-LL-dd'));
    cur = cur.plus({ days: 1 });
  }
  return out;
}

export function createRequest(opts: {
  requesterSlackId: string;
  type: TimeOffType;
  startDate: string;
  endDate: string;
  startTime?: string | null;   // HH:mm; ambos set para permiso fraccionario
  endTime?: string | null;
  reason: string | null;
  source: 'web' | 'bot';
}): TimeOffRequest {
  // Si una de las dos horas está set, ambas deben estarlo
  const startTime = opts.startTime || null;
  const endTime = opts.endTime || null;
  if ((startTime && !endTime) || (!startTime && endTime)) {
    throw new Error('start_time y end_time deben ir juntos (o ambos vacíos para día completo)');
  }
  // Permiso fraccionario solo válido si start_date === end_date (un solo día)
  if (startTime && opts.startDate !== opts.endDate) {
    throw new Error('Permiso por horas debe ser de un solo día (start_date = end_date)');
  }
  const r = db.prepare(`
    INSERT INTO time_off_requests
      (requester_slack_id, type, start_date, end_date, start_time, end_time, reason, status, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    opts.requesterSlackId, opts.type, opts.startDate, opts.endDate,
    startTime, endTime, opts.reason, opts.source
  );
  return getRequest(r.lastInsertRowid as number)!;
}

export function getRequest(id: number): TimeOffRequest | undefined {
  return db.prepare('SELECT * FROM time_off_requests WHERE id = ?').get(id) as TimeOffRequest | undefined;
}

export function listByRequester(slackId: string): TimeOffRequest[] {
  return db.prepare('SELECT * FROM time_off_requests WHERE requester_slack_id = ? ORDER BY created_at DESC')
    .all(slackId) as TimeOffRequest[];
}

export function listAll(filter?: { status?: TimeOffStatus }): TimeOffRequest[] {
  if (filter?.status) {
    return db.prepare('SELECT * FROM time_off_requests WHERE status = ? ORDER BY created_at DESC')
      .all(filter.status) as TimeOffRequest[];
  }
  return db.prepare('SELECT * FROM time_off_requests ORDER BY created_at DESC').all() as TimeOffRequest[];
}

export function listPending(): TimeOffRequest[] {
  return db.prepare("SELECT * FROM time_off_requests WHERE status = 'pending' ORDER BY created_at ASC")
    .all() as TimeOffRequest[];
}

/** Detects pending or approved overlap for the same agent in a date range. */
export function findOverlappingActive(slackId: string, startDate: string, endDate: string, excludeId?: number): TimeOffRequest | undefined {
  const rows = db.prepare(`
    SELECT * FROM time_off_requests
    WHERE requester_slack_id = ?
      AND status IN ('pending', 'approved')
      AND NOT (end_date < ? OR start_date > ?)
      ${excludeId ? 'AND id != ?' : ''}
    LIMIT 1
  `).get(...(excludeId ? [slackId, startDate, endDate, excludeId] : [slackId, startDate, endDate])) as TimeOffRequest | undefined;
  return rows;
}

/**
 * Approve and apply.
 *
 * - Día completo (start_time/end_time null): crea days_off_entries para cada
 *   fecha en el rango. Comportamiento legacy idempotente.
 *
 * - Permiso fraccionario (start_time + end_time set, una sola fecha):
 *   modifica el schedule_entry del día para "recortar" la ventana de trabajo.
 *   • Permiso al inicio del shift (start_time = shift_start): custom_start_hour
 *     = end_time del permiso (agente entra tarde).
 *   • Permiso al final del shift (end_time = shift_end): custom_end_hour
 *     = start_time del permiso (agente sale temprano).
 *   • Permiso en medio del shift: rechaza con error (caso poco común; el
 *     manager lo gestiona a mano partiendo el shift).
 *
 * Atomic.
 */
export function approveAndApply(id: number, approverSlackId: string, plannerId: number) {
  const tx = db.transaction(() => {
    const req = getRequest(id);
    if (!req) throw new Error('not found');
    if (req.status !== 'pending') throw new Error('not pending');

    // Caso día completo
    if (!isPartialRequest(req)) {
      db.prepare(`
        UPDATE time_off_requests
        SET status = 'approved', approver_slack_id = ?, approval_at = datetime('now')
        WHERE id = ?
      `).run(approverSlackId, id);
      const dates = listDates(req.start_date, req.end_date);
      for (const date of dates) {
        insertDayOffEntry(plannerId, date, req.type);
      }
      return;
    }

    // Caso permiso fraccionario
    const date = req.start_date;
    const se = findScheduleEntry(plannerId, date);
    if (!se) {
      throw new Error(`El agente no tiene turno asignado el ${date}, no se puede aprobar permiso por horas.`);
    }
    const shift = SHIFTS[se.dept]?.[se.shift_id];
    if (!shift) throw new Error(`Shift desconocido: ${se.dept}.${se.shift_id}`);
    const shiftStartHour = se.custom_start_hour ?? shift.startHour;
    const shiftEndHour   = se.custom_end_hour   ?? shift.endHour;
    const offStart = parseHm(req.start_time);
    const offEnd   = parseHm(req.end_time);
    if (offStart == null || offEnd == null) throw new Error('Horas inválidas en la solicitud.');
    if (offEnd <= offStart) throw new Error('Hora fin debe ser mayor que hora inicio.');

    // Determinar tipo de recorte
    const epsilon = 0.01;
    const atFront = Math.abs(offStart - shiftStartHour) < epsilon;
    const atBack  = Math.abs(offEnd   - shiftEndHour)   < epsilon;
    if (!atFront && !atBack) {
      throw new Error(
        `Permiso debe ser al inicio o al final del turno (turno ${shiftStartHour}:00–${shiftEndHour}:00 UTC). ` +
        `Permisos a la mitad del turno deben gestionarse manualmente partiendo el turno.`
      );
    }

    let newStart = shiftStartHour;
    let newEnd = shiftEndHour;
    if (atFront) newStart = offEnd;   // agente entra tarde
    if (atBack)  newEnd = offStart;   // agente sale temprano

    db.prepare(`
      UPDATE schedule_entries
      SET custom_start_hour = ?, custom_end_hour = ?
      WHERE id = ?
    `).run(newStart, newEnd, se.id);

    db.prepare(`
      UPDATE time_off_requests
      SET status = 'approved', approver_slack_id = ?, approval_at = datetime('now')
      WHERE id = ?
    `).run(approverSlackId, id);
  });
  tx();
}

export function reject(id: number, approverSlackId: string, reason: string | null) {
  db.prepare(`
    UPDATE time_off_requests
    SET status = 'rejected', approver_slack_id = ?, approval_at = datetime('now'), rejection_reason = ?
    WHERE id = ? AND status = 'pending'
  `).run(approverSlackId, reason, id);
}

/**
 * Delete a request (manager/admin action). If it was approved, rolls back the
 * days_off_entries that were created by approveAndApply, restoring the agent's
 * original planner-defined schedule. Atomic.
 */
export function deleteRequest(id: number, plannerId: number | null) {
  const tx = db.transaction(() => {
    const req = getRequest(id);
    if (!req) return;
    if (req.status === 'approved' && plannerId !== null) {
      if (isPartialRequest(req)) {
        // Restaurar el schedule_entry del día (limpiar custom_start/end_hour)
        db.prepare(`
          UPDATE schedule_entries
          SET custom_start_hour = NULL, custom_end_hour = NULL
          WHERE planner_id = ? AND date = ?
        `).run(plannerId, req.start_date);
      } else {
        db.prepare(`
          DELETE FROM days_off_entries
          WHERE planner_id = ? AND date >= ? AND date <= ?
        `).run(plannerId, req.start_date, req.end_date);
      }
    }
    db.prepare('DELETE FROM time_off_requests WHERE id = ?').run(id);
  });
  tx();
}

export function cancel(id: number, requesterSlackId: string) {
  db.prepare(`
    UPDATE time_off_requests
    SET status = 'cancelled'
    WHERE id = ? AND requester_slack_id = ? AND status = 'pending'
  `).run(id, requesterSlackId);
}

/** #6b: Manager/admin override — cancels a pending request even if not the requester. */
export function cancelByManager(id: number) {
  db.prepare(`
    UPDATE time_off_requests
    SET status = 'cancelled'
    WHERE id = ? AND status = 'pending'
  `).run(id);
}

export function setDmTargets(id: number, targets: DmTarget[]) {
  db.prepare('UPDATE time_off_requests SET approval_dm_targets = ? WHERE id = ?')
    .run(JSON.stringify(targets), id);
}

export function getDmTargets(id: number): DmTarget[] {
  const r = db.prepare('SELECT approval_dm_targets FROM time_off_requests WHERE id = ?').get(id) as { approval_dm_targets: string | null } | undefined;
  if (!r?.approval_dm_targets) return [];
  try { return JSON.parse(r.approval_dm_targets) as DmTarget[]; } catch { return []; }
}

/**
 * Sum of vacation days consumed by an agent in a given calendar year, based
 * on approved time-off requests of type 'vacaciones'. Counts the number of
 * dates in [start_date, end_date] that fall within `year`. Cancelled and
 * rejected requests are ignored.
 */
/**
 * Sum of vacation days consumed by an agent in a given calendar year.
 *
 * - Día completo: cada fecha aprobada cuenta 1 día.
 * - Fraccionario (start_time/end_time set): cuenta una fracción
 *   proporcional al shift del día. Ej: 4h sobre shift de 8h = 0.5 días.
 *   Si el shift no es resoluble (sin schedule_entry), asume 8h.
 *
 * Devuelve un número decimal (ej. 5.5 días).
 */
export function vacationDaysUsedInYear(slackId: string, year: number): number {
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const rows = db.prepare(`
    SELECT start_date, end_date, start_time, end_time
      FROM time_off_requests
     WHERE requester_slack_id = ? AND type = 'vacaciones' AND status = 'approved'
       AND NOT (end_date < ? OR start_date > ?)
  `).all(slackId, yearStart, yearEnd) as {
    start_date: string; end_date: string; start_time: string | null; end_time: string | null
  }[];
  let total = 0;
  const agent = getAgentBySlackId(slackId);
  for (const r of rows) {
    // Caso fraccionario
    if (r.start_time && r.end_time && r.start_date === r.end_date) {
      const offStart = parseHm(r.start_time);
      const offEnd = parseHm(r.end_time);
      if (offStart == null || offEnd == null) continue;
      const hoursOff = offEnd - offStart;
      // Estimar duración del shift del día
      let shiftHours = 8;
      if (agent) {
        const se = findScheduleEntry(agent.planner_id, r.start_date);
        if (se) {
          const sh = SHIFTS[se.dept]?.[se.shift_id];
          const startH = se.custom_start_hour ?? sh?.startHour ?? 0;
          const endH = se.custom_end_hour ?? sh?.endHour ?? 8;
          if (endH > startH) shiftHours = endH - startH;
        }
      }
      total += Math.max(0, hoursOff / shiftHours);
      continue;
    }
    // Caso día completo (rango)
    const s = r.start_date < yearStart ? yearStart : r.start_date;
    const e = r.end_date > yearEnd ? yearEnd : r.end_date;
    const ds = DateTime.fromISO(s, { zone: 'utc' });
    const de = DateTime.fromISO(e, { zone: 'utc' });
    total += Math.max(0, Math.round(de.diff(ds, 'days').days) + 1);
  }
  // Redondear a 2 decimales para evitar floats feos
  return Math.round(total * 100) / 100;
}

export function setRequesterDm(id: number, channel: string, ts: string) {
  db.prepare('UPDATE time_off_requests SET requester_dm_channel = ?, requester_dm_ts = ? WHERE id = ?')
    .run(channel, ts, id);
}
