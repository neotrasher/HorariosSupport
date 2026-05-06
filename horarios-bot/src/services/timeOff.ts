import { DateTime } from 'luxon';
import { db } from '../db';
import { insertDayOffEntry } from './schedule';

export type TimeOffType = 'permiso' | 'vacaciones';
export type TimeOffStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export type TimeOffRequest = {
  id: number;
  requester_slack_id: string;
  type: TimeOffType;
  start_date: string;
  end_date: string;
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
  reason: string | null;
  source: 'web' | 'bot';
}): TimeOffRequest {
  const r = db.prepare(`
    INSERT INTO time_off_requests
      (requester_slack_id, type, start_date, end_date, reason, status, source)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(opts.requesterSlackId, opts.type, opts.startDate, opts.endDate, opts.reason, opts.source);
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
 * Approve and apply: sets status, creates days_off_entries for each date in range.
 * Idempotent on days_off via INSERT OR IGNORE. Atomic.
 */
export function approveAndApply(id: number, approverSlackId: string, plannerId: number) {
  const tx = db.transaction(() => {
    const req = getRequest(id);
    if (!req) throw new Error('not found');
    if (req.status !== 'pending') throw new Error('not pending');

    db.prepare(`
      UPDATE time_off_requests
      SET status = 'approved', approver_slack_id = ?, approval_at = datetime('now')
      WHERE id = ?
    `).run(approverSlackId, id);

    const dates = listDates(req.start_date, req.end_date);
    for (const date of dates) {
      insertDayOffEntry(plannerId, date, req.type);
    }
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
      db.prepare(`
        DELETE FROM days_off_entries
        WHERE planner_id = ? AND date >= ? AND date <= ?
      `).run(plannerId, req.start_date, req.end_date);
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
export function vacationDaysUsedInYear(slackId: string, year: number): number {
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const rows = db.prepare(`
    SELECT start_date, end_date FROM time_off_requests
    WHERE requester_slack_id = ? AND type = 'vacaciones' AND status = 'approved'
      AND NOT (end_date < ? OR start_date > ?)
  `).all(slackId, yearStart, yearEnd) as { start_date: string; end_date: string }[];
  let total = 0;
  for (const r of rows) {
    const s = r.start_date < yearStart ? yearStart : r.start_date;
    const e = r.end_date > yearEnd ? yearEnd : r.end_date;
    const ds = DateTime.fromISO(s, { zone: 'utc' });
    const de = DateTime.fromISO(e, { zone: 'utc' });
    total += Math.max(0, Math.round(de.diff(ds, 'days').days) + 1);
  }
  return total;
}

export function setRequesterDm(id: number, channel: string, ts: string) {
  db.prepare('UPDATE time_off_requests SET requester_dm_channel = ?, requester_dm_ts = ? WHERE id = ?')
    .run(channel, ts, id);
}
