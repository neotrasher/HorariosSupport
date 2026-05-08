import { DateTime } from 'luxon';
import { db } from '../db';
import { SHIFTS, ShiftDef } from '../config';

export type Assignment =
  | { kind: 'shift'; entry_id: number; date: string; dept: string; shift_id: string; shift: ShiftDef; customStartHour: number | null; customEndHour: number | null }
  | { kind: 'off'; date: string };

export type AssignmentSnapshot =
  | { kind: 'shift'; dept: string; shift_id: string }
  | { kind: 'off' };

export type SwapStatus =
  | 'pending_partner'
  | 'pending_approval'
  | 'approved'
  | 'rejected_partner'
  | 'rejected_approver'
  | 'cancelled';

export type SwapRequest = {
  id: number;
  requester_slack_id: string;
  partner_slack_id: string;
  requester_date: string;
  partner_date: string;
  requester_snapshot: string;
  partner_snapshot: string;
  note: string | null;
  status: SwapStatus;
  partner_response_at: string | null;
  partner_dm_channel: string | null;
  partner_dm_ts: string | null;
  approval_dm_channel: string | null;
  approval_dm_ts: string | null;
  approval_dm_targets: string | null;
  approver_slack_id: string | null;
  approval_at: string | null;
  rejection_reason: string | null;
  executed_at: string | null;
  created_at: string;
};

/**
 * Returns the agent's single assignment on a UTC date, or null if ambiguous/missing.
 * Ambiguous: more than one schedule row, or schedule row + days_off entry.
 */
export function getAssignmentForDate(plannerId: number, date: DateTime): Assignment | null {
  const dateStr = date.toUTC().toFormat('yyyy-LL-dd');

  const schedRows = db.prepare(`
    SELECT id, dept, shift_id, custom_start_hour, custom_end_hour FROM schedule_entries
    WHERE date = ? AND planner_id = ?
  `).all(dateStr, plannerId) as {
    id: number; dept: string; shift_id: string;
    custom_start_hour: number | null; custom_end_hour: number | null;
  }[];

  const dayOff = db.prepare(`
    SELECT 1 FROM days_off_entries WHERE planner_id = ? AND date = ?
  `).get(plannerId, dateStr);

  if (schedRows.length === 1 && !dayOff) {
    const r = schedRows[0];
    const shift = SHIFTS[r.dept]?.[r.shift_id];
    if (!shift) return null;
    return {
      kind: 'shift', entry_id: r.id, date: dateStr,
      dept: r.dept, shift_id: r.shift_id, shift,
      customStartHour: r.custom_start_hour, customEndHour: r.custom_end_hour
    };
  }
  if (schedRows.length === 0 && dayOff) {
    return { kind: 'off', date: dateStr };
  }
  return null;
}

export function snapshotOf(a: Assignment): AssignmentSnapshot {
  return a.kind === 'shift'
    ? { kind: 'shift', dept: a.dept, shift_id: a.shift_id }
    : { kind: 'off' };
}

export function describeSnapshot(s: AssignmentSnapshot): string {
  if (s.kind === 'off') return 'Día libre';
  const shift = SHIFTS[s.dept]?.[s.shift_id];
  if (!shift) return `${s.dept} ${s.shift_id}`;
  const fmtH = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;
  return `${s.dept} ${shift.label} (${fmtH(shift.startHour)}–${fmtH(shift.endHour)} UTC)`;
}

export function describeAssignment(a: Assignment): string {
  if (a.kind === 'off') return 'Día libre';
  const startH = a.customStartHour ?? a.shift.startHour;
  const endH = a.customEndHour ?? a.shift.endHour;
  const fmtH = (h: number) => `${String(Math.floor(h) % 24).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
  const partial = (a.customStartHour != null || a.customEndHour != null) ? ' *parcial*' : '';
  return `${a.dept} ${a.shift.label} (${fmtH(startH)}–${fmtH(endH)} UTC)${partial}`;
}

/**
 * Look for any pending swap (pending_partner or pending_approval) that already
 * involves either agent on either of the two dates. Used to prevent overlap.
 */
export function findOverlappingPending(
  aSlack: string, bSlack: string, aDate: string, bDate: string
): SwapRequest | null {
  const row = db.prepare(`
    SELECT * FROM swap_requests
    WHERE status IN ('pending_partner', 'pending_approval')
      AND (
        (requester_slack_id = ? AND requester_date = ?) OR
        (requester_slack_id = ? AND requester_date = ?) OR
        (partner_slack_id   = ? AND partner_date   = ?) OR
        (partner_slack_id   = ? AND partner_date   = ?) OR
        (requester_slack_id = ? AND requester_date = ?) OR
        (partner_slack_id   = ? AND partner_date   = ?)
      )
    LIMIT 1
  `).get(
    aSlack, aDate,
    bSlack, bDate,
    aSlack, aDate,
    bSlack, bDate,
    bSlack, bDate,
    aSlack, aDate
  ) as SwapRequest | undefined;
  return row || null;
}

export function createSwapRequest(opts: {
  requesterSlackId: string;
  partnerSlackId: string;
  requesterDate: string;
  partnerDate: string;
  requesterSnapshot: AssignmentSnapshot;
  partnerSnapshot: AssignmentSnapshot;
  note: string | null;
}): number {
  const info = db.prepare(`
    INSERT INTO swap_requests (
      requester_slack_id, partner_slack_id,
      requester_date, partner_date,
      requester_snapshot, partner_snapshot,
      note, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_partner')
  `).run(
    opts.requesterSlackId, opts.partnerSlackId,
    opts.requesterDate, opts.partnerDate,
    JSON.stringify(opts.requesterSnapshot), JSON.stringify(opts.partnerSnapshot),
    opts.note
  );
  return Number(info.lastInsertRowid);
}

export function getSwapRequest(id: number): SwapRequest | null {
  return (db.prepare('SELECT * FROM swap_requests WHERE id = ?').get(id) as SwapRequest | undefined) || null;
}

export function setPartnerDM(id: number, channel: string, ts: string) {
  db.prepare(`UPDATE swap_requests SET partner_dm_channel = ?, partner_dm_ts = ? WHERE id = ?`)
    .run(channel, ts, id);
}

export function setApprovalDM(id: number, channel: string, ts: string, targets: string[]) {
  db.prepare(`
    UPDATE swap_requests
    SET approval_dm_channel = ?, approval_dm_ts = ?, approval_dm_targets = ?
    WHERE id = ?
  `).run(channel, ts, JSON.stringify(targets), id);
}

export function markPartnerAccepted(id: number) {
  db.prepare(`
    UPDATE swap_requests
    SET status = 'pending_approval', partner_response_at = datetime('now')
    WHERE id = ? AND status = 'pending_partner'
  `).run(id);
}

export function markPartnerRejected(id: number, reason: string | null) {
  db.prepare(`
    UPDATE swap_requests
    SET status = 'rejected_partner', partner_response_at = datetime('now'), rejection_reason = ?
    WHERE id = ? AND status = 'pending_partner'
  `).run(reason, id);
}

export function markApproverRejected(id: number, approverSlackId: string, reason: string | null) {
  db.prepare(`
    UPDATE swap_requests
    SET status = 'rejected_approver',
        approver_slack_id = ?,
        approval_at = datetime('now'),
        rejection_reason = ?
    WHERE id = ? AND status = 'pending_approval'
  `).run(approverSlackId, reason, id);
}

/**
 * Approve and execute the swap atomically. Returns true on success, false if
 * the swap was already resolved by someone else (race) or assignments changed.
 */
export function approveAndExecute(id: number, approverSlackId: string): { ok: true } | { ok: false; reason: string } {
  const tx = db.transaction(() => {
    const req = getSwapRequest(id);
    if (!req) return { ok: false as const, reason: 'No existe la solicitud.' };
    if (req.status !== 'pending_approval') return { ok: false as const, reason: 'La solicitud ya fue resuelta.' };

    const reqAgent = db.prepare('SELECT planner_id FROM agents WHERE slack_id = ?')
      .get(req.requester_slack_id) as { planner_id: number } | undefined;
    const partnerAgent = db.prepare('SELECT planner_id FROM agents WHERE slack_id = ?')
      .get(req.partner_slack_id) as { planner_id: number } | undefined;
    if (!reqAgent || !partnerAgent) return { ok: false as const, reason: 'Uno de los agentes ya no está vinculado.' };

    const reqDate = DateTime.fromISO(req.requester_date, { zone: 'utc' });
    const partnerDate = DateTime.fromISO(req.partner_date, { zone: 'utc' });
    const reqAssign = getAssignmentForDate(reqAgent.planner_id, reqDate);
    const partnerAssign = getAssignmentForDate(partnerAgent.planner_id, partnerDate);
    if (!reqAssign || !partnerAssign) {
      return { ok: false as const, reason: 'Las asignaciones cambiaron desde que se creó la solicitud.' };
    }

    const expectReq = JSON.parse(req.requester_snapshot) as AssignmentSnapshot;
    const expectPartner = JSON.parse(req.partner_snapshot) as AssignmentSnapshot;
    if (!sameSnapshot(snapshotOf(reqAssign), expectReq) || !sameSnapshot(snapshotOf(partnerAssign), expectPartner)) {
      return { ok: false as const, reason: 'Las asignaciones cambiaron desde que se creó la solicitud.' };
    }

    // Swap = reassign each side's existing record to the other agent.
    reassign(reqAssign, reqAgent.planner_id, partnerAgent.planner_id);
    reassign(partnerAssign, partnerAgent.planner_id, reqAgent.planner_id);

    db.prepare(`
      UPDATE swap_requests
      SET status = 'approved',
          approver_slack_id = ?,
          approval_at = datetime('now'),
          executed_at = datetime('now')
      WHERE id = ?
    `).run(approverSlackId, id);

    return { ok: true as const };
  });
  return tx();
}

function sameSnapshot(a: AssignmentSnapshot, b: AssignmentSnapshot): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'shift' && b.kind === 'shift') {
    return a.dept === b.dept && a.shift_id === b.shift_id;
  }
  return true;
}

/** Pending swaps that still need partner accept or manager approval. */
export function listPendingSwaps(): SwapRequest[] {
  return db.prepare(`
    SELECT * FROM swap_requests
    WHERE status IN ('pending_partner', 'pending_approval')
    ORDER BY created_at DESC
  `).all() as SwapRequest[];
}

/** All swaps, newest first. Optional status filter. */
export function listAllSwaps(opts: { status?: SwapStatus } = {}): SwapRequest[] {
  if (opts.status) {
    return db.prepare(`
      SELECT * FROM swap_requests WHERE status = ? ORDER BY created_at DESC
    `).all(opts.status) as SwapRequest[];
  }
  return db.prepare(`
    SELECT * FROM swap_requests ORDER BY created_at DESC
  `).all() as SwapRequest[];
}

/** Swaps where the user appears as either requester or partner. */
export function listSwapsForUser(slackId: string): SwapRequest[] {
  return db.prepare(`
    SELECT * FROM swap_requests
    WHERE requester_slack_id = ? OR partner_slack_id = ?
    ORDER BY created_at DESC
  `).all(slackId, slackId) as SwapRequest[];
}

/** Reassign an existing assignment record from one agent to another. */
function reassign(a: Assignment, fromPlannerId: number, toPlannerId: number) {
  if (a.kind === 'shift') {
    db.prepare(`UPDATE schedule_entries SET planner_id = ?, source = 'swap' WHERE id = ?`)
      .run(toPlannerId, a.entry_id);
  } else {
    db.prepare(`
      UPDATE days_off_entries SET planner_id = ?
      WHERE planner_id = ? AND date = ?
    `).run(toPlannerId, fromPlannerId, a.date);
  }
}
