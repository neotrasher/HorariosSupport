/**
 * Break coordination service.
 *
 * Agents working the same (dept, shift, date) cohort can reserve a 30-min
 * break slot so they don't all leave at once. Reservations are optional —
 * an agent can also click Break In directly, and the cohort cap enforces
 * concurrency.
 *
 * Rules:
 *  - Default cap = 1 per dept (e.g. only 1 L1 in break at a time).
 *  - If the cohort has 4+ agents, cap auto-scales to 2.
 *  - "Soft overlap": when allowing a new break would temporarily exceed the
 *    cap, but the agent(s) already in break will return within MAX_OVERLAP_MIN
 *    (default 30), the new break is allowed and called a "shared overlap".
 *  - Reservations expire RESERVATION_GRACE_MIN minutes after their slot
 *    starts if the agent never clocks break_in.
 *  - L1 and L2 are independent — they never compete for the same cap.
 *
 * This service does NOT post Slack messages or render UI. It returns plain
 * data structures that the action handlers / web routes consume.
 */
import { DateTime } from 'luxon';
import { db } from '../db';
import { SHIFTS, config } from '../config';
import {
  getAllShiftsForDate, shiftWindow, ResolvedShift
} from './schedule';
import { getAgentBySlackId } from './agents';

// ── Tunables ────────────────────────────────────────────────────────────
/** Cohort size threshold at which the cap auto-scales from 1 to 2. */
const COHORT_LARGE_THRESHOLD = 4;
/** Default cap (small cohort). */
const DEFAULT_CAP_SMALL = 1;
/** Default cap when cohort >= COHORT_LARGE_THRESHOLD. */
const DEFAULT_CAP_LARGE = 2;
/** Minutes of overlap permitted when granting a "shared" break. */
const MAX_OVERLAP_MIN = 30;
/** Slot length in minutes. */
const SLOT_MIN = 30;
/** Minutes after slot_start a reservation expires if not used. */
const RESERVATION_GRACE_MIN = 15;
/** Earliest break slot offset from shift start (minutes). */
const BREAK_WINDOW_OFFSET_START_MIN = 60;
/** Buffer en minutos AL FINAL del turno tras terminar el break (wrap up).
 *  El break debe terminar a más tardar shift_end - SHIFT_END_BUFFER_MIN. */
export const SHIFT_END_BUFFER_MIN = 30;
/** Latest break slot offset from shift end (minutes). */
const BREAK_WINDOW_OFFSET_END_MIN = SHIFT_END_BUFFER_MIN;

// ── Types ───────────────────────────────────────────────────────────────
export interface CohortMember {
  slack_id: string;
  name: string;
  planner_id: number;
}

export interface Reservation {
  id: number;
  slack_id: string;
  shift_date: string;
  dept: string;
  shift_id: string;
  slot_start: string;          // ISO UTC
  duration_min: number;
  status: 'active' | 'taken' | 'expired' | 'cancelled';
  created_at: string;
  updated_at: string;
}

export interface SlotInfo {
  start: DateTime;
  end: DateTime;
  /** Slot id used in action values: 'YYYY-MM-DD|dept|shift|HH:mm'. */
  key: string;
  /** Reservations active on this slot (could be 0 to cap). */
  reservations: { reservation_id: number; slack_id: string; name: string }[];
  /** Agents currently on break whose break time overlaps this slot. */
  onBreak: { slack_id: string; name: string; break_in_ts: string }[];
  /** True if this slot is "full" relative to the cohort cap. */
  full: boolean;
}

export interface BreakEligibility {
  ok: boolean;
  /** If !ok, human-readable reason in Spanish (no slang). */
  reason?: string;
  /** If allowed via soft-overlap, a friendly note for the agent. */
  note?: string;
  /** If !ok, suggest next free slot start. */
  suggestionSlotStart?: DateTime;
}

// ── Cohort + cap helpers ────────────────────────────────────────────────

/**
 * Functional cohort: agentes con la misma DEPT NATIVA (a.dept) que tienen
 * cualquier schedule_entry hoy. Se usa para calcular el cap y la concurrencia
 * de break — la idea es que un L2 nativo cubriendo L1.T sigue siendo "L2"
 * para efectos de cobertura: su break impacta la cola L2, no la L1.
 */
export function listFunctionalCohort(nativeDept: string, shiftDate: string): CohortMember[] {
  const rows = db.prepare(`
    SELECT DISTINCT a.slack_id, a.name, a.planner_id
      FROM agents a
      JOIN schedule_entries s ON s.planner_id = a.planner_id
     WHERE a.active = 1 AND a.dept = ? AND s.date = ?
       AND NOT EXISTS (
         SELECT 1 FROM days_off_entries d
          WHERE d.planner_id = a.planner_id AND d.date = s.date
       )
  `).all(nativeDept, shiftDate) as { slack_id: string; name: string; planner_id: number }[];
  return rows;
}

/**
 * Cap basado en functional cohort para un agente. Cohort size escala el cap:
 * 1 por defecto, 2 si el cohort tiene COHORT_LARGE_THRESHOLD+ agentes.
 */
export function getFunctionalCohortCap(slackId: string, shiftDate: string): {
  cap: number;
  cohortSize: number;
  nativeDept: string;
} {
  const agent = getAgentBySlackId(slackId);
  if (!agent) return { cap: DEFAULT_CAP_SMALL, cohortSize: 0, nativeDept: '?' };
  const cohort = listFunctionalCohort(agent.dept, shiftDate);
  const cap = cohort.length >= COHORT_LARGE_THRESHOLD ? DEFAULT_CAP_LARGE : DEFAULT_CAP_SMALL;
  return { cap, cohortSize: cohort.length, nativeDept: agent.dept };
}

/**
 * Agentes del functional cohort que están en break ahora (break_in sin
 * break_out posterior, en cualquier shift del día). Esto incluye L2 nativos
 * que cubren L1 o viceversa.
 */
export function listAgentsOnBreakByFunction(
  nativeDept: string, shiftDate: string
): { slack_id: string; break_in_ts: string; dur_min: number }[] {
  const cohort = listFunctionalCohort(nativeDept, shiftDate);
  if (cohort.length === 0) return [];
  const cohortIds = cohort.map(c => c.slack_id);
  const placeholders = cohortIds.map(() => '?').join(',');

  const rows = db.prepare(`
    SELECT p.slack_id, p.ts, p.note
      FROM punches p
     WHERE p.shift_date = ? AND p.type = 'break_in'
       AND p.slack_id IN (${placeholders})
       AND NOT EXISTS (
         SELECT 1 FROM punches q
          WHERE q.slack_id = p.slack_id AND q.shift_date = p.shift_date
            AND q.shift_id = p.shift_id AND q.type = 'break_out'
            AND q.ts > p.ts
       )
  `).all(shiftDate, ...cohortIds) as { slack_id: string; ts: string; note: string | null }[];
  const result: { slack_id: string; break_in_ts: string; dur_min: number }[] = [];
  for (const r of rows) {
    const m = r.note?.match(/dur=(\d+)/);
    const dur = m ? parseInt(m[1], 10) : 60;
    result.push({ slack_id: r.slack_id, break_in_ts: r.ts, dur_min: dur });
  }
  return result;
}

/** Agents scheduled for this (dept, shift, date), excluding day-off. */
export function listCohort(dept: string, shiftId: string, shiftDate: string): CohortMember[] {
  const date = DateTime.fromISO(shiftDate, { zone: 'utc' });
  if (!date.isValid) return [];
  const shifts = getAllShiftsForDate(date).filter(s => s.dept === dept && s.shift.id === shiftId);
  const members: CohortMember[] = [];
  for (const rs of shifts) {
    // planner_id → slack_id via agents table
    const row = db.prepare(
      "SELECT slack_id, name FROM agents WHERE planner_id = ? AND active = 1"
    ).get(rs.planner_id) as { slack_id: string; name: string } | undefined;
    if (row) members.push({ slack_id: row.slack_id, name: row.name, planner_id: rs.planner_id });
  }
  return members;
}

/** Effective cap for a cohort. Scales with cohort size by default. */
export function getCohortCap(dept: string, shiftId: string, shiftDate: string): {
  cap: number;
  maxOverlapMin: number;
  slotMin: number;
  cohortSize: number;
} {
  const size = listCohort(dept, shiftId, shiftDate).length;
  const cap = size >= COHORT_LARGE_THRESHOLD ? DEFAULT_CAP_LARGE : DEFAULT_CAP_SMALL;
  return { cap, maxOverlapMin: MAX_OVERLAP_MIN, slotMin: SLOT_MIN, cohortSize: size };
}

// ── Slot generation ─────────────────────────────────────────────────────

/**
 * Generate the list of 30-min break slots available for a cohort on a date.
 * The window excludes the first/last hour of the shift (no breaks right
 * after clock-in or right before clock-out).
 */
export function generateSlots(
  dept: string,
  shiftId: string,
  shiftDate: string
): SlotInfo[] {
  const shift = SHIFTS[dept]?.[shiftId];
  if (!shift) return [];
  const date = DateTime.fromISO(shiftDate, { zone: 'utc' });
  if (!date.isValid) return [];
  const win = shiftWindow(date, { startHour: shift.startHour, endHour: shift.endHour });
  const windowStart = win.start.plus({ minutes: BREAK_WINDOW_OFFSET_START_MIN });
  const windowEnd = win.end.minus({ minutes: BREAK_WINDOW_OFFSET_END_MIN });

  // Reservations in this cohort
  const resvRows = db.prepare(`
    SELECT id, slack_id, slot_start, duration_min, status
    FROM break_reservations
    WHERE shift_date = ? AND dept = ? AND shift_id = ? AND status = 'active'
  `).all(shiftDate, dept, shiftId) as {
    id: number; slack_id: string; slot_start: string; duration_min: number; status: string
  }[];

  // Agents currently on break in this cohort (from punches)
  const onBreakRows = listAgentsOnBreakInCohort(dept, shiftId, shiftDate);

  const slots: SlotInfo[] = [];
  let cursor = windowStart;
  while (cursor.plus({ minutes: SLOT_MIN }) <= windowEnd) {
    const slotStart = cursor;
    const slotEnd = cursor.plus({ minutes: SLOT_MIN });
    const slotKey = `${shiftDate}|${dept}|${shiftId}|${slotStart.toFormat('HH:mm')}`;

    // Reservations whose [slot_start, slot_start+duration) overlaps this slot
    const reservations: SlotInfo['reservations'] = [];
    for (const r of resvRows) {
      const rStart = DateTime.fromISO(r.slot_start, { zone: 'utc' });
      const rEnd = rStart.plus({ minutes: r.duration_min });
      if (rStart < slotEnd && rEnd > slotStart) {
        const ag = getAgentBySlackId(r.slack_id);
        reservations.push({
          reservation_id: r.id,
          slack_id: r.slack_id,
          name: ag?.name || r.slack_id
        });
      }
    }

    // Agents currently in break whose break time overlaps this slot
    const onBreak: SlotInfo['onBreak'] = [];
    for (const ob of onBreakRows) {
      const biTs = DateTime.fromISO(ob.break_in_ts, { zone: 'utc' });
      // Treat ongoing break as ending at biTs + dur_min (or +60 fallback)
      const obEnd = biTs.plus({ minutes: ob.dur_min || 60 });
      if (biTs < slotEnd && obEnd > slotStart) {
        const ag = getAgentBySlackId(ob.slack_id);
        onBreak.push({ slack_id: ob.slack_id, name: ag?.name || ob.slack_id, break_in_ts: ob.break_in_ts });
      }
    }

    const cap = getCohortCap(dept, shiftId, shiftDate).cap;
    const consumed = reservations.length + onBreak.length;
    slots.push({
      start: slotStart,
      end: slotEnd,
      key: slotKey,
      reservations,
      onBreak,
      full: consumed >= cap
    });

    cursor = cursor.plus({ minutes: SLOT_MIN });
  }
  return slots;
}

/**
 * Variante de generateSlots desde la perspectiva de UN agente específico.
 * Slots se calculan en su ventana de shift, pero el flag `full` y las
 * reservas/breaks que aparecen consideran el FUNCTIONAL COHORT (todos los
 * agentes con la misma dept nativa scheduleados ese día).
 *
 * Usado por el DM picker para que Maria (L2 nativa en L1.T) vea reservas
 * de Nelly (L2 nativa en L2.M) y compita con ella por el cap de L2.
 */
export function generateSlotsForAgent(opts: {
  slackId: string;
  dept: string;       // shift's dept (where the agent is working)
  shiftId: string;
  shiftDate: string;
}): SlotInfo[] {
  const shift = SHIFTS[opts.dept]?.[opts.shiftId];
  if (!shift) return [];
  const date = DateTime.fromISO(opts.shiftDate, { zone: 'utc' });
  if (!date.isValid) return [];
  const agent = getAgentBySlackId(opts.slackId);
  if (!agent) return [];
  const nativeDept = agent.dept;
  const { cap } = getFunctionalCohortCap(opts.slackId, opts.shiftDate);

  // Ventana de break en el shift del agente
  const win = shiftWindow(date, { startHour: shift.startHour, endHour: shift.endHour });
  const windowStart = win.start.plus({ minutes: BREAK_WINDOW_OFFSET_START_MIN });
  const windowEnd = win.end.minus({ minutes: BREAK_WINDOW_OFFSET_END_MIN });

  // Reservas activas del functional cohort (cualquier shift hoy)
  const cohort = listFunctionalCohort(nativeDept, opts.shiftDate);
  const cohortIds = cohort.map(c => c.slack_id);
  let resvRows: { id: number; slack_id: string; slot_start: string; duration_min: number }[] = [];
  if (cohortIds.length > 0) {
    const ph = cohortIds.map(() => '?').join(',');
    resvRows = db.prepare(`
      SELECT id, slack_id, slot_start, duration_min
        FROM break_reservations
       WHERE shift_date = ? AND status = 'active'
         AND slack_id IN (${ph})
    `).all(opts.shiftDate, ...cohortIds) as typeof resvRows;
  }

  // Agentes del functional cohort en break ahora
  const onBreakRows = listAgentsOnBreakByFunction(nativeDept, opts.shiftDate);

  const slots: SlotInfo[] = [];
  let cursor = windowStart;
  while (cursor.plus({ minutes: SLOT_MIN }) <= windowEnd) {
    const slotStart = cursor;
    const slotEnd = cursor.plus({ minutes: SLOT_MIN });
    const slotKey = `${opts.shiftDate}|${opts.dept}|${opts.shiftId}|${slotStart.toFormat('HH:mm')}`;

    const reservations: SlotInfo['reservations'] = [];
    for (const r of resvRows) {
      const rStart = DateTime.fromISO(r.slot_start, { zone: 'utc' });
      const rEnd = rStart.plus({ minutes: r.duration_min });
      if (rStart < slotEnd && rEnd > slotStart) {
        const ag = getAgentBySlackId(r.slack_id);
        reservations.push({
          reservation_id: r.id,
          slack_id: r.slack_id,
          name: ag?.name || r.slack_id
        });
      }
    }

    const onBreak: SlotInfo['onBreak'] = [];
    for (const ob of onBreakRows) {
      const biTs = DateTime.fromISO(ob.break_in_ts, { zone: 'utc' });
      const obEnd = biTs.plus({ minutes: ob.dur_min || 60 });
      if (biTs < slotEnd && obEnd > slotStart) {
        const ag = getAgentBySlackId(ob.slack_id);
        onBreak.push({ slack_id: ob.slack_id, name: ag?.name || ob.slack_id, break_in_ts: ob.break_in_ts });
      }
    }

    const consumed = reservations.length + onBreak.length;
    slots.push({
      start: slotStart, end: slotEnd, key: slotKey,
      reservations, onBreak,
      full: consumed >= cap
    });
    cursor = cursor.plus({ minutes: SLOT_MIN });
  }
  return slots;
}

// ── Reservation CRUD ────────────────────────────────────────────────────

/** Reserve a slot. Returns { ok, error?, reservationId? }. */
export function reserveSlot(opts: {
  slackId: string;
  shiftDate: string;
  dept: string;
  shiftId: string;
  slotStartISO: string;       // ISO UTC
  durationMin: number;        // 30 or 60
}): { ok: boolean; error?: string; reservationId?: number } {
  const slotStart = DateTime.fromISO(opts.slotStartISO, { zone: 'utc' });
  if (!slotStart.isValid) return { ok: false, error: 'Slot inválido.' };
  if (![30, 60].includes(opts.durationMin)) return { ok: false, error: 'Duración inválida.' };

  // Cancel any existing active reservation for this agent on this shift
  db.prepare(`
    UPDATE break_reservations
       SET status = 'cancelled', updated_at = datetime('now')
     WHERE slack_id = ? AND shift_date = ? AND dept = ? AND shift_id = ? AND status = 'active'
  `).run(opts.slackId, opts.shiftDate, opts.dept, opts.shiftId);

  // Check capacity at the requested slot(s) usando functional cohort
  const slots = generateSlotsForAgent({
    slackId: opts.slackId,
    dept: opts.dept,
    shiftId: opts.shiftId,
    shiftDate: opts.shiftDate
  });
  const slotsTouched = Math.ceil(opts.durationMin / SLOT_MIN);
  const targetIdx = slots.findIndex(s =>
    s.start.toISO() === slotStart.toISO()
  );
  if (targetIdx < 0) return { ok: false, error: 'Ese slot no está dentro de la ventana permitida.' };
  for (let i = 0; i < slotsTouched; i++) {
    const s = slots[targetIdx + i];
    if (!s) return { ok: false, error: 'El break de 60 min no cabe a esa hora (excede la ventana).' };
    if (s.full) return { ok: false, error: `El slot ${s.start.toFormat('HH:mm')} ya está lleno.` };
  }

  const result = db.prepare(`
    INSERT INTO break_reservations (slack_id, shift_date, dept, shift_id, slot_start, duration_min, status)
    VALUES (?, ?, ?, ?, ?, ?, 'active')
  `).run(
    opts.slackId, opts.shiftDate, opts.dept, opts.shiftId,
    slotStart.toUTC().toISO()!, opts.durationMin
  );
  return { ok: true, reservationId: result.lastInsertRowid as number };
}

/** Cancel an active reservation. */
export function cancelReservation(reservationId: number): boolean {
  const r = db.prepare(`
    UPDATE break_reservations
       SET status = 'cancelled', updated_at = datetime('now')
     WHERE id = ? AND status = 'active'
  `).run(reservationId);
  return r.changes > 0;
}

/** Cancel all active reservations for a user on a shift. Returns count cancelled. */
export function cancelReservationsForShift(slackId: string, shiftDate: string, dept: string, shiftId: string): number {
  const r = db.prepare(`
    UPDATE break_reservations
       SET status = 'cancelled', updated_at = datetime('now')
     WHERE slack_id = ? AND shift_date = ? AND dept = ? AND shift_id = ? AND status = 'active'
  `).run(slackId, shiftDate, dept, shiftId);
  return r.changes;
}

/** Get an agent's current active reservation for a shift (if any). */
export function getActiveReservation(
  slackId: string, shiftDate: string, dept: string, shiftId: string
): Reservation | null {
  const row = db.prepare(`
    SELECT * FROM break_reservations
     WHERE slack_id = ? AND shift_date = ? AND dept = ? AND shift_id = ? AND status = 'active'
     ORDER BY id DESC LIMIT 1
  `).get(slackId, shiftDate, dept, shiftId) as Reservation | undefined;
  return row || null;
}

/** Mark a reservation as "taken" when the agent actually clocks break_in. */
export function markReservationTaken(reservationId: number) {
  db.prepare(`
    UPDATE break_reservations SET status = 'taken', updated_at = datetime('now') WHERE id = ?
  `).run(reservationId);
}

/**
 * Sweep expired reservations: any active reservation whose slot started more
 * than RESERVATION_GRACE_MIN minutes ago without the agent clocking break_in.
 * Returns the rows that were just expired (for notification purposes).
 */
export function sweepExpiredReservations(now: DateTime = DateTime.utc()): Reservation[] {
  const cutoff = now.minus({ minutes: RESERVATION_GRACE_MIN }).toISO();
  const expiring = db.prepare(`
    SELECT * FROM break_reservations
     WHERE status = 'active' AND slot_start <= ?
  `).all(cutoff) as Reservation[];
  if (expiring.length === 0) return [];

  // For each, only expire if the agent did NOT clock break_in for this slot
  const toExpire: number[] = [];
  for (const r of expiring) {
    const slotStart = DateTime.fromISO(r.slot_start, { zone: 'utc' });
    const window = {
      from: slotStart.minus({ minutes: 5 }).toISO(),
      to:   slotStart.plus({ minutes: r.duration_min + RESERVATION_GRACE_MIN }).toISO()
    };
    const hasBreakIn = db.prepare(`
      SELECT 1 FROM punches
       WHERE slack_id = ? AND type = 'break_in'
         AND ts >= ? AND ts <= ?
       LIMIT 1
    `).get(r.slack_id, window.from, window.to);
    if (!hasBreakIn) toExpire.push(r.id);
  }
  if (toExpire.length === 0) return [];
  const placeholders = toExpire.map(() => '?').join(',');
  db.prepare(
    `UPDATE break_reservations SET status = 'expired', updated_at = datetime('now') WHERE id IN (${placeholders})`
  ).run(...toExpire);
  return expiring.filter(r => toExpire.includes(r.id));
}

// ── Break eligibility (the runtime decision) ────────────────────────────

/**
 * Agents in this cohort whose latest punch is `break_in` without a matching
 * `break_out` — i.e. currently on break. dur_min comes from the break_in note
 * (encoded as `dur=30` or `dur=60`).
 *
 * IMPORTANT: la membresía del cohort se determina por la entrada en
 * schedule_entries (el turno que el agente está CUBRIENDO ese día), NO por
 * su dept nativa. Así un agente L2 que cubre L1.T cuenta para el cap de L1
 * durante ese día, aunque su perfil siga marcándolo como L2.
 */
export function listAgentsOnBreakInCohort(
  dept: string, shiftId: string, shiftDate: string
): { slack_id: string; break_in_ts: string; dur_min: number }[] {
  // Cohort actual (basado en schedule_entries) — quién está REALMENTE
  // cubriendo este (dept, shift) hoy, independiente de su dept nativa.
  const cohort = listCohort(dept, shiftId, shiftDate);
  if (cohort.length === 0) return [];
  const cohortIds = cohort.map(c => c.slack_id);
  const placeholders = cohortIds.map(() => '?').join(',');

  // Filtrar break_in sin break_out posterior, restringido al cohort.
  const rows = db.prepare(`
    SELECT p.slack_id, p.ts, p.note
      FROM punches p
     WHERE p.shift_date = ? AND p.shift_id = ? AND p.type = 'break_in'
       AND p.slack_id IN (${placeholders})
       AND NOT EXISTS (
         SELECT 1 FROM punches q
          WHERE q.slack_id = p.slack_id AND q.shift_date = p.shift_date
            AND q.shift_id = p.shift_id AND q.type = 'break_out'
            AND q.ts > p.ts
       )
  `).all(shiftDate, shiftId, ...cohortIds) as { slack_id: string; ts: string; note: string | null }[];
  const result: { slack_id: string; break_in_ts: string; dur_min: number }[] = [];
  for (const r of rows) {
    const m = r.note?.match(/dur=(\d+)/);
    const dur = m ? parseInt(m[1], 10) : 60;
    result.push({ slack_id: r.slack_id, break_in_ts: r.ts, dur_min: dur });
  }
  return result;
}

/**
 * The runtime decision: can `slackId` start a break right now?
 * Applies cap + soft-overlap logic. Caller passes the desired durationMin.
 */
export function canTakeBreakNow(opts: {
  slackId: string;
  dept: string;
  shiftId: string;
  shiftDate: string;
  durationMin: number;
  now?: DateTime;
}): BreakEligibility {
  const now = opts.now ?? DateTime.utc();
  // Cap se calcula por functional cohort (native dept del agente), NO por shift.
  // Un L2 nativo cubriendo L1.T compite con otros L2 nativos por el cap de L2.
  const { cap, nativeDept } = getFunctionalCohortCap(opts.slackId, opts.shiftDate);
  const maxOverlapMin = MAX_OVERLAP_MIN;

  // 1. If the agent has an active reservation in the current window, allow.
  const reservation = getActiveReservation(opts.slackId, opts.shiftDate, opts.dept, opts.shiftId);
  if (reservation) {
    const rStart = DateTime.fromISO(reservation.slot_start, { zone: 'utc' });
    const minutesToSlot = rStart.diff(now, 'minutes').minutes;
    if (minutesToSlot > 5) {
      return {
        ok: false,
        reason: `Tu break es a las ${rStart.toFormat('HH:mm')} UTC, faltan ${Math.round(minutesToSlot)} min. Si necesitas adelantarlo, cambia tu reserva.`,
        suggestionSlotStart: rStart
      };
    }
    // Within window or past the slot start → allow (the reservation is "ours")
    return { ok: true };
  }

  // 2. No reservation → functional cohort capacity check.
  const onBreak = listAgentsOnBreakByFunction(nativeDept, opts.shiftDate)
    .filter(b => b.slack_id !== opts.slackId);

  if (onBreak.length < cap) {
    // Free capacity — also check if cohort members reservaron este momento.
    // Listar reservas activas de todos los del cohort (puede ser otro shift).
    const cohort = listFunctionalCohort(nativeDept, opts.shiftDate);
    const cohortIds = cohort.map(c => c.slack_id).filter(id => id !== opts.slackId);
    const intended = { from: now, to: now.plus({ minutes: opts.durationMin }) };
    let conflictingResv: { slack_id: string; slot_start: string; duration_min: number }[] = [];
    if (cohortIds.length > 0) {
      const ph = cohortIds.map(() => '?').join(',');
      conflictingResv = db.prepare(`
        SELECT slack_id, slot_start, duration_min
          FROM break_reservations
         WHERE shift_date = ? AND status = 'active'
           AND slack_id IN (${ph})
      `).all(opts.shiftDate, ...cohortIds) as {
        slack_id: string; slot_start: string; duration_min: number
      }[];
    }
    // Reservations whose window overlaps with the intended break window
    const overlapping = conflictingResv.filter(r => {
      const s = DateTime.fromISO(r.slot_start, { zone: 'utc' });
      const e = s.plus({ minutes: r.duration_min });
      return s < intended.to && e > intended.from;
    });
    // Capacity check including pending reservations
    if (onBreak.length + overlapping.length >= cap) {
      const owner = overlapping[0];
      const ag = owner ? getAgentBySlackId(owner.slack_id) : null;
      return {
        ok: false,
        reason: `${ag?.name || 'Alguien'} reservó este momento. Reserva otra hora o espera a que pase.`,
        suggestionSlotStart: owner ? DateTime.fromISO(owner.slot_start, { zone: 'utc' }) : undefined
      };
    }
    return { ok: true };
  }

  // 3. Cohort at cap. Soft-overlap check: are the breaks-in-progress going
  //    to end soon enough that the overlap will be ≤ maxOverlapMin?
  // Find the latest "end time" among on-break agents.
  let earliestEnd: DateTime | null = null;
  for (const b of onBreak) {
    const biTs = DateTime.fromISO(b.break_in_ts, { zone: 'utc' });
    const end = biTs.plus({ minutes: b.dur_min });
    if (!earliestEnd || end < earliestEnd) earliestEnd = end;
  }
  if (earliestEnd) {
    const overlapMin = Math.min(
      opts.durationMin,
      earliestEnd.diff(now, 'minutes').minutes
    );
    if (overlapMin <= maxOverlapMin && overlapMin > 0) {
      const who = onBreak.map(b => getAgentBySlackId(b.slack_id)?.name || b.slack_id).join(', ');
      return {
        ok: true,
        note: `${who} está en break hasta ~${earliestEnd.toFormat('HH:mm')}. Compartirán ${Math.round(overlapMin)} min.`
      };
    }
    // Overlap would be too long → block, suggest waiting until the earliestEnd
    const who = onBreak.map(b => getAgentBySlackId(b.slack_id)?.name || b.slack_id).join(', ');
    return {
      ok: false,
      reason: `${who} está en break hasta ~${earliestEnd.toFormat('HH:mm')} UTC. Espera o reserva un slot más tarde.`,
      suggestionSlotStart: earliestEnd
    };
  }
  return { ok: false, reason: 'No hay capacidad para break en este momento.' };
}

/**
 * Build the data the DM block needs to render the slot picker for an agent.
 * Returns null if breaks coordination is not relevant for this shift (e.g.
 * window is empty, or shift is too short).
 *
 * Slot labels se formatean en la TZ del agente (de su perfil) para ser
 * consistente con el resto del DM que usa Slack `<!date^...>` (TZ del
 * usuario que mira). Si el agente no tiene TZ configurada, fallback al
 * displayTimezone del sistema, y de último UTC.
 */
export function buildBreakInfoForDM(opts: {
  slackId: string;
  dept: string;
  shiftId: string;
  shiftDate: string;
}): {
  freeOptions: { slotISO: string; label: string; durationMin: number }[];
  myReservation: { slotISO: string; label: string; durationMin: number } | null;
  otherReservations: { name: string; label: string; durationMin: number }[];
  upcomingNext8h: { name: string; dept: string; labelLocal: string; durationMin: number; status: string }[];
  tzLabel: string;
} | null {
  // Slots desde la perspectiva del agente (functional cohort para cap)
  const slots = generateSlotsForAgent({
    slackId: opts.slackId,
    dept: opts.dept,
    shiftId: opts.shiftId,
    shiftDate: opts.shiftDate
  });
  if (slots.length === 0) return null;

  // Resolver TZ del agente para formatear labels en local
  const agent = getAgentBySlackId(opts.slackId);
  const tz = (agent?.timezone) || config.displayTimezone || 'UTC';
  const tzLabel = tz === 'UTC' ? 'UTC' : (tz.split('/').pop() || 'local').replace(/_/g, ' ');
  const fmtLocal = (iso: string) => DateTime.fromISO(iso, { zone: 'utc' }).setZone(tz).toFormat('HH:mm');

  const my = getActiveReservation(opts.slackId, opts.shiftDate, opts.dept, opts.shiftId);
  const myReservation = my
    ? {
        slotISO: my.slot_start,
        label: fmtLocal(my.slot_start),
        durationMin: my.duration_min
      }
    : null;

  // Free options: slots not full + en el futuro + con tiempo suficiente
  // para que el break termine ≥ SHIFT_END_BUFFER_MIN antes del shift_end.
  const now = DateTime.utc();
  const shift = SHIFTS[opts.dept]?.[opts.shiftId];
  const date = DateTime.fromISO(opts.shiftDate, { zone: 'utc' });
  const shiftEnd = shift ? date.startOf('day').plus({ hours: shift.endHour }) : null;

  const freeOptions: { slotISO: string; label: string; durationMin: number }[] = [];
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (s.full) continue;
    // Saltar slots que ya pasaron (con tolerancia de 5 min para evitar
    // que el slot actual desaparezca por desincronía de reloj)
    if (s.start.plus({ minutes: 5 }) < now) continue;
    const startISO = s.start.toISO()!;
    // 30 min: end ≤ shift_end - 30
    const end30 = s.start.plus({ minutes: 30 });
    if (!shiftEnd || end30.plus({ minutes: SHIFT_END_BUFFER_MIN }) <= shiftEnd) {
      freeOptions.push({ slotISO: startISO, label: fmtLocal(startISO), durationMin: 30 });
    }
    // 60 min: ambos slots libres Y end ≤ shift_end - 30
    if (i + 1 < slots.length && !slots[i + 1].full) {
      const end60 = s.start.plus({ minutes: 60 });
      if (!shiftEnd || end60.plus({ minutes: SHIFT_END_BUFFER_MIN }) <= shiftEnd) {
        freeOptions.push({ slotISO: startISO, label: fmtLocal(startISO), durationMin: 60 });
      }
    }
  }

  // Others' reservations en mismo cohort, dedup por reservation_id (no por nombre+slot
  // así soportamos múltiples reservas del mismo agente si las hubiera).
  const seenResvIds = new Set<number>();
  const otherReservations: { name: string; label: string; durationMin: number }[] = [];
  for (const s of slots) {
    for (const r of s.reservations) {
      if (r.slack_id === opts.slackId) continue;
      if (seenResvIds.has(r.reservation_id)) continue;
      seenResvIds.add(r.reservation_id);
      const resvRow = db.prepare(`
        SELECT duration_min, slot_start FROM break_reservations WHERE id = ?
      `).get(r.reservation_id) as { duration_min: number; slot_start: string } | undefined;
      if (!resvRow) continue;
      otherReservations.push({
        name: r.name.split(' ')[0],
        label: fmtLocal(resvRow.slot_start),
        durationMin: resvRow.duration_min
      });
    }
  }

  // Próximas 8h en cualquier cohort, para visibilidad cross-team
  const upcoming = listUpcomingBreaks({ now, hoursAhead: 8 });
  const upcomingNext8h = upcoming
    .filter(u => u.slack_id !== opts.slackId)  // no me incluyo a mí mismo
    .map(u => ({
      name: u.name.split(' ')[0],
      dept: u.dept,
      labelLocal: DateTime.fromISO(u.slot_start, { zone: 'utc' }).setZone(tz).toFormat('HH:mm'),
      durationMin: u.durationMin,
      status: u.status
    }));

  return { freeOptions, myReservation, otherReservations, upcomingNext8h, tzLabel };
}

/**
 * Lista los breaks (reservados + en curso) en una ventana próxima desde `now`,
 * sin filtrar por cohort. Útil para mostrar "qué viene en las próximas 8h"
 * en el DM y en el slash command.
 */
export function listUpcomingBreaks(opts: {
  now?: DateTime;
  hoursAhead?: number;
}): {
  slack_id: string;
  name: string;
  dept: string;           // dept del shift donde la reserva vive
  shift_id: string;
  slot_start: string;     // ISO UTC
  slotLabelUtc: string;
  durationMin: number;
  status: 'active' | 'taken' | 'in_break';
}[] {
  const now = opts.now ?? DateTime.utc();
  const hoursAhead = opts.hoursAhead ?? 8;
  const windowEnd = now.plus({ hours: hoursAhead });
  const today = now.toFormat('yyyy-LL-dd');
  const tomorrow = now.plus({ days: 1 }).toFormat('yyyy-LL-dd');

  // Reservaciones activas + tomadas en las próximas N horas
  const resvRows = db.prepare(`
    SELECT id, slack_id, shift_date, dept, shift_id, slot_start, duration_min, status
      FROM break_reservations
     WHERE shift_date IN (?, ?)
       AND status IN ('active', 'taken')
       AND slot_start <= ?
     ORDER BY slot_start ASC
  `).all(today, tomorrow, windowEnd.toISO()) as {
    id: number; slack_id: string; shift_date: string; dept: string;
    shift_id: string; slot_start: string; duration_min: number; status: string;
  }[];

  const items: ReturnType<typeof listUpcomingBreaks> = [];
  for (const r of resvRows) {
    const slotStart = DateTime.fromISO(r.slot_start, { zone: 'utc' });
    const slotEnd = slotStart.plus({ minutes: r.duration_min });
    // Si la reserva ya pasó completa, no mostrarla
    if (slotEnd < now) continue;
    const ag = getAgentBySlackId(r.slack_id);
    items.push({
      slack_id: r.slack_id,
      name: ag?.name || r.slack_id,
      dept: r.dept,
      shift_id: r.shift_id,
      slot_start: r.slot_start,
      slotLabelUtc: slotStart.toFormat('HH:mm'),
      durationMin: r.duration_min,
      status: r.status as 'active' | 'taken'
    });
  }

  // Agentes EN BREAK ahora (sin break_out aún)
  const onBreakRows = db.prepare(`
    SELECT p.slack_id, p.ts, p.note, p.shift_date, p.shift_id
      FROM punches p
     WHERE p.shift_date IN (?, ?) AND p.type = 'break_in'
       AND NOT EXISTS (
         SELECT 1 FROM punches q
          WHERE q.slack_id = p.slack_id AND q.shift_date = p.shift_date
            AND q.shift_id = p.shift_id AND q.type = 'break_out'
            AND q.ts > p.ts
       )
  `).all(today, tomorrow) as {
    slack_id: string; ts: string; note: string | null; shift_date: string; shift_id: string;
  }[];
  for (const ob of onBreakRows) {
    const ag = getAgentBySlackId(ob.slack_id);
    const m = ob.note?.match(/dur=(\d+)/);
    const dur = m ? parseInt(m[1], 10) : 60;
    const biTs = DateTime.fromISO(ob.ts, { zone: 'utc' });
    // Si ya tiene reserva taken correspondiente, evitar duplicar
    const alreadyTaken = items.find(it => it.slack_id === ob.slack_id && it.status === 'taken' &&
      DateTime.fromISO(it.slot_start, { zone: 'utc' }).diff(biTs, 'minutes').minutes < 10
    );
    if (alreadyTaken) continue;
    items.push({
      slack_id: ob.slack_id,
      name: ag?.name || ob.slack_id,
      dept: ag?.dept || '?',
      shift_id: ob.shift_id,
      slot_start: ob.ts,
      slotLabelUtc: biTs.toFormat('HH:mm'),
      durationMin: dur,
      status: 'in_break'
    });
  }

  // Ordenar cronológicamente
  items.sort((a, b) => a.slot_start.localeCompare(b.slot_start));
  return items;
}

/** List ALL active+taken reservations for a date (manager view). */
export function listReservationsForDate(date: string): Reservation[] {
  return db.prepare(`
    SELECT * FROM break_reservations
     WHERE shift_date = ? AND status IN ('active','taken')
     ORDER BY dept, shift_id, slot_start ASC
  `).all(date) as Reservation[];
}

// ── Manager dashboard helper ────────────────────────────────────────────

export interface CohortSlotCell {
  reservations: {
    reservation_id: number;
    slack_id: string;
    name: string;
    durationMin: number;
    status: string;
    /** true si este es el slot donde arranca la reserva (no una continuación). */
    isAnchor: boolean;
    /** Label "HH:mm" del slot donde arranca la reserva (para mostrar en continuación). */
    anchorLabel: string;
    /** Label "HH:mm" del fin de la reserva (slot_start + durationMin). */
    endLabel: string;
  }[];
  onBreak: { slack_id: string; name: string; break_in_ts: string }[];
}

export interface CohortBlockForView {
  dept: string;
  shift_id: string;
  shiftLabel: string;
  startHour: number;
  endHour: number;
  cohort: CohortMember[];
  cap: number;
  cohortSize: number;
  slots: {
    label: string;       // HH:mm
    startISO: string;
    cell: CohortSlotCell;
    full: boolean;
  }[];
}

/**
 * Build all cohort blocks for a date (one per dept+shift with active agents).
 * Used by the /horarios/breaks dashboard.
 */
export function buildBreaksDashboard(shiftDate: string): CohortBlockForView[] {
  const date = DateTime.fromISO(shiftDate, { zone: 'utc' });
  if (!date.isValid) return [];
  const blocks: CohortBlockForView[] = [];
  for (const dept of Object.keys(SHIFTS).sort()) {
    for (const sh of Object.values(SHIFTS[dept])) {
      const cohort = listCohort(dept, sh.id, shiftDate);
      if (cohort.length === 0) continue;
      const { cap, cohortSize } = getCohortCap(dept, sh.id, shiftDate);
      const slots = generateSlots(dept, sh.id, shiftDate);
      const slotsView = slots.map(s => {
        const reservations = s.reservations.map(r => {
          const resvRow = db.prepare(
            "SELECT duration_min, status, slot_start FROM break_reservations WHERE id = ?"
          ).get(r.reservation_id) as { duration_min: number; status: string; slot_start: string } | undefined;
          const durationMin = resvRow?.duration_min ?? 30;
          const resvStartISO = resvRow?.slot_start ?? '';
          const resvStart = resvStartISO ? DateTime.fromISO(resvStartISO, { zone: 'utc' }) : s.start;
          const resvEnd = resvStart.plus({ minutes: durationMin });
          return {
            reservation_id: r.reservation_id,
            slack_id: r.slack_id,
            name: r.name,
            durationMin,
            status: resvRow?.status ?? 'active',
            isAnchor: resvStart.toISO() === s.start.toISO(),
            anchorLabel: resvStart.toFormat('HH:mm'),
            endLabel: resvEnd.toFormat('HH:mm')
          };
        });
        return {
          label: s.start.toFormat('HH:mm'),
          startISO: s.start.toISO()!,
          cell: { reservations, onBreak: s.onBreak },
          full: s.full
        };
      });
      blocks.push({
        dept, shift_id: sh.id, shiftLabel: sh.label,
        startHour: sh.startHour, endHour: sh.endHour,
        cohort, cap, cohortSize, slots: slotsView
      });
    }
  }
  return blocks;
}
