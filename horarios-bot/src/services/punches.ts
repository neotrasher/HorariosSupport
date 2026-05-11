import { DateTime } from 'luxon';
import { db } from '../db';

export type PunchType = 'clock_in' | 'clock_out' | 'break_in' | 'break_out';
export type ShiftState = 'off' | 'in' | 'on_break' | 'completed';

export type Punch = {
  id: number;
  slack_id: string;
  type: PunchType;
  ts: string;
  source: string;
  note: string | null;
  shift_date: string | null;
  shift_id: string | null;
};

export function recordPunch(
  slackId: string,
  type: PunchType,
  opts: {
    source?: 'button' | 'manual' | 'test' | 'auto';
    ts?: DateTime;
    note?: string;
    shiftDate?: string;
    shiftId?: string;
  } = {}
) {
  const ts = (opts.ts ?? DateTime.utc()).toUTC().toISO();
  db.prepare(`
    INSERT INTO punches (slack_id, type, ts, source, note, shift_date, shift_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    slackId, type, ts,
    opts.source ?? 'button',
    opts.note ?? null,
    opts.shiftDate ?? null,
    opts.shiftId ?? null
  );
}

export function getPunchesOnDate(slackId: string, date: DateTime): Punch[] {
  const start = date.toUTC().startOf('day').toISO();
  const end = date.toUTC().endOf('day').toISO();
  return db.prepare(`
    SELECT * FROM punches
    WHERE slack_id = ? AND ts >= ? AND ts <= ?
    ORDER BY ts ASC
  `).all(slackId, start, end) as Punch[];
}

/** Returns the agent's current state based on most recent punch in the last 18 hours. */
export function getCurrentState(slackId: string): ShiftState {
  const since = DateTime.utc().minus({ hours: 18 }).toISO();
  const last = db.prepare(`
    SELECT type FROM punches
    WHERE slack_id = ? AND ts >= ?
    ORDER BY ts DESC LIMIT 1
  `).get(slackId, since) as { type: PunchType } | undefined;
  if (!last) return 'off';
  if (last.type === 'clock_in' || last.type === 'break_out') return 'in';
  if (last.type === 'break_in') return 'on_break';
  if (last.type === 'clock_out') return 'completed';
  return 'off';
}

/**
 * Returns the state for a SPECIFIC shift identified by (slack_id, shift_date, shift_id).
 * Only considers punches associated with that shift. Completely independent across shifts.
 */
export function getShiftState(slackId: string, shiftDate: string, shiftId: string): ShiftState {
  const last = db.prepare(`
    SELECT type FROM punches
    WHERE slack_id = ? AND shift_date = ? AND shift_id = ?
    ORDER BY ts DESC LIMIT 1
  `).get(slackId, shiftDate, shiftId) as { type: PunchType } | undefined;
  if (!last) return 'off';
  if (last.type === 'clock_in' || last.type === 'break_out') return 'in';
  if (last.type === 'break_in') return 'on_break';
  if (last.type === 'clock_out') return 'completed';
  return 'off';
}

/** Wipe all punches for a user on a given UTC date. Used by /punch-reset for testing. */
export function clearPunchesForDate(slackId: string, shiftDate: string): number {
  const r = db.prepare(`
    DELETE FROM punches WHERE slack_id = ? AND shift_date = ?
  `).run(slackId, shiftDate);
  return r.changes as number;
}

/** Delete a single punch by id. Used by undo flow. Returns true if found+deleted. */
export function deletePunchById(id: number): boolean {
  const r = db.prepare('DELETE FROM punches WHERE id = ?').run(id);
  return (r.changes as number) > 0;
}

export function hasClockInOnDate(slackId: string, date: DateTime): boolean {
  const punches = getPunchesOnDate(slackId, date);
  return punches.some(p => p.type === 'clock_in');
}

export function getShiftMessage(slackId: string, shiftDate: string, shiftId: string) {
  return db.prepare(`
    SELECT channel_id, message_ts FROM shift_messages
    WHERE slack_id = ? AND shift_date = ? AND shift_id = ?
  `).get(slackId, shiftDate, shiftId) as { channel_id: string; message_ts: string } | undefined;
}

export function setShiftMessage(
  slackId: string, shiftDate: string, shiftId: string, channelId: string, ts: string
) {
  db.prepare(`
    INSERT OR REPLACE INTO shift_messages (slack_id, shift_date, shift_id, channel_id, message_ts)
    VALUES (?, ?, ?, ?, ?)
  `).run(slackId, shiftDate, shiftId, channelId, ts);
}

/** Most recent punch (any type) for a specific shift, or null. */
export function lastPunchForShift(slackId: string, shiftDate: string, shiftId: string): Punch | null {
  const r = db.prepare(`
    SELECT * FROM punches
    WHERE slack_id = ? AND shift_date = ? AND shift_id = ?
    ORDER BY ts DESC LIMIT 1
  `).get(slackId, shiftDate, shiftId) as Punch | undefined;
  return r || null;
}

/** Most recent break_in punch ts (UTC ISO) for a specific shift, or null. */
export function lastBreakInTs(slackId: string, shiftDate: string, shiftId: string): string | null {
  const r = db.prepare(`
    SELECT ts FROM punches
    WHERE slack_id = ? AND shift_date = ? AND shift_id = ? AND type = 'break_in'
    ORDER BY ts DESC LIMIT 1
  `).get(slackId, shiftDate, shiftId) as { ts: string } | undefined;
  return r?.ts || null;
}

/** Most recent break_in with its chosen duration (parsed from note, default 60). */
export function lastBreakInWithDur(slackId: string, shiftDate: string, shiftId: string): { ts: string; durMin: number } | null {
  const r = db.prepare(`
    SELECT ts, note FROM punches
    WHERE slack_id = ? AND shift_date = ? AND shift_id = ? AND type = 'break_in'
    ORDER BY ts DESC LIMIT 1
  `).get(slackId, shiftDate, shiftId) as { ts: string; note: string | null } | undefined;
  if (!r) return null;
  // Note format: "dur=30" or "dur=60"; missing = legacy 60-min break
  const m = (r.note || '').match(/dur=(\d+)/);
  const durMin = m ? parseInt(m[1], 10) : 60;
  return { ts: r.ts, durMin };
}

/** Agents currently on break: latest punch in their (slack, shift) is a break_in within last 18h. */
export function listAgentsOnBreak(): { slack_id: string; shift_date: string; shift_id: string; break_in_ts: string; dur_min: number }[] {
  const rows = db.prepare(`
    SELECT p.slack_id, p.shift_date, p.shift_id, p.ts AS break_in_ts, p.note FROM punches p
    WHERE p.type = 'break_in'
      AND p.shift_date IS NOT NULL AND p.shift_id IS NOT NULL
      AND p.ts >= datetime('now', '-18 hours')
      AND NOT EXISTS (
        SELECT 1 FROM punches p2
        WHERE p2.slack_id = p.slack_id
          AND p2.shift_date = p.shift_date
          AND p2.shift_id = p.shift_id
          AND p2.ts > p.ts
      )
  `).all() as { slack_id: string; shift_date: string; shift_id: string; break_in_ts: string; note: string | null }[];
  return rows.map(r => {
    const m = (r.note || '').match(/dur=(\d+)/);
    const dur_min = m ? parseInt(m[1], 10) : 60;
    return { slack_id: r.slack_id, shift_date: r.shift_date, shift_id: r.shift_id, break_in_ts: r.break_in_ts, dur_min };
  });
}

/** Agents whose latest shift-scoped punch is clock_in or break_out (state='in'). */
export function listInShiftAgents(): { slack_id: string; shift_date: string; shift_id: string; last_ts: string; last_type: string }[] {
  return db.prepare(`
    SELECT p.slack_id, p.shift_date, p.shift_id, p.ts AS last_ts, p.type AS last_type FROM punches p
    WHERE p.shift_date IS NOT NULL AND p.shift_id IS NOT NULL
      AND p.type IN ('clock_in', 'break_out')
      AND p.ts >= datetime('now', '-36 hours')
      AND NOT EXISTS (
        SELECT 1 FROM punches p2
        WHERE p2.slack_id = p.slack_id
          AND p2.shift_date = p.shift_date
          AND p2.shift_id = p.shift_id
          AND p2.ts > p.ts
      )
  `).all() as { slack_id: string; shift_date: string; shift_id: string; last_ts: string; last_type: string }[];
}

/** All punches scoped to a specific shift (slack, shift_date, shift_id). */
export function getPunchesForShift(slackId: string, shiftDate: string, shiftId: string): Punch[] {
  return db.prepare(`
    SELECT * FROM punches
    WHERE slack_id = ? AND shift_date = ? AND shift_id = ?
    ORDER BY ts ASC
  `).all(slackId, shiftDate, shiftId) as Punch[];
}

export function updatePunchNote(punchId: number, note: string) {
  db.prepare('UPDATE punches SET note = ? WHERE id = ?').run(note, punchId);
}

export function lastPunchId(slackId: string, shiftDate: string, shiftId: string, type: PunchType): number | null {
  const r = db.prepare(`
    SELECT id FROM punches
    WHERE slack_id = ? AND shift_date = ? AND shift_id = ? AND type = ?
    ORDER BY ts DESC LIMIT 1
  `).get(slackId, shiftDate, shiftId, type) as { id: number } | undefined;
  return r?.id || null;
}

export function alertAlreadySent(
  slackId: string, shiftDate: string, shiftId: string, alertType: string
): boolean {
  const r = db.prepare(`
    SELECT 1 FROM alerts_sent
    WHERE slack_id = ? AND shift_date = ? AND shift_id = ? AND alert_type = ?
  `).get(slackId, shiftDate, shiftId, alertType);
  return !!r;
}

export function markAlertSent(
  slackId: string, shiftDate: string, shiftId: string, alertType: string
) {
  db.prepare(`
    INSERT OR IGNORE INTO alerts_sent (slack_id, shift_date, shift_id, alert_type)
    VALUES (?, ?, ?, ?)
  `).run(slackId, shiftDate, shiftId, alertType);
}
