/**
 * Helper for /horarios views: for a date range, returns which agents have
 * PENDING requests (timeoff or swap) that overlap. Used to mark chips with
 * a small badge so managers see "this person has a pending ask" while
 * looking at the schedule.
 */
import { db } from '../db';

export interface PendingMark {
  /** 'permiso' | 'vacaciones' if there's a pending time-off request */
  timeoff: string | null;
  /** 'requester' | 'partner' if there's a pending swap request involving this agent on this date */
  swap: 'requester' | 'partner' | null;
  /** Optional ID for linking */
  timeoffId: number | null;
  swapId: number | null;
}

/** Empty mark singleton to avoid object allocation. */
const EMPTY: PendingMark = { timeoff: null, swap: null, timeoffId: null, swapId: null };

/**
 * For each (slackId, date) combo within the range, returns whether there's
 * a pending request. Key = `${slackId}|${date}`.
 */
export function buildPendingByAgentDate(startDate: string, endDate: string): Map<string, PendingMark> {
  const result = new Map<string, PendingMark>();

  // Helper: get-or-create
  function get(slackId: string, date: string): PendingMark {
    const k = `${slackId}|${date}`;
    let m = result.get(k);
    if (!m) {
      m = { timeoff: null, swap: null, timeoffId: null, swapId: null };
      result.set(k, m);
    }
    return m;
  }

  // ── Pending timeoff (vacaciones/permiso): expand the request range ─────
  const timeoffs = db.prepare(`
    SELECT id, requester_slack_id, type, start_date, end_date
    FROM time_off_requests
    WHERE status = 'pending'
      AND start_date <= ? AND end_date >= ?
  `).all(endDate, startDate) as { id: number; requester_slack_id: string; type: string; start_date: string; end_date: string }[];

  for (const t of timeoffs) {
    // Walk each date in [max(start, rangeStart), min(end, rangeEnd)]
    const from = t.start_date < startDate ? startDate : t.start_date;
    const to = t.end_date > endDate ? endDate : t.end_date;
    let cursor = new Date(from + 'T00:00:00Z');
    const stop = new Date(to + 'T00:00:00Z');
    while (cursor <= stop) {
      const dateStr = cursor.toISOString().slice(0, 10);
      const m = get(t.requester_slack_id, dateStr);
      m.timeoff = t.type;
      m.timeoffId = t.id;
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }

  // ── Pending swaps: only the two specific dates ─────────────────────────
  const swaps = db.prepare(`
    SELECT id, requester_slack_id, partner_slack_id, requester_date, partner_date
    FROM swap_requests
    WHERE status IN ('pending_partner', 'pending_approval')
      AND (
        (requester_date >= ? AND requester_date <= ?) OR
        (partner_date   >= ? AND partner_date   <= ?)
      )
  `).all(startDate, endDate, startDate, endDate) as {
    id: number; requester_slack_id: string; partner_slack_id: string;
    requester_date: string; partner_date: string;
  }[];

  for (const s of swaps) {
    if (s.requester_date >= startDate && s.requester_date <= endDate) {
      const m = get(s.requester_slack_id, s.requester_date);
      m.swap = 'requester'; m.swapId = s.id;
    }
    if (s.partner_date >= startDate && s.partner_date <= endDate) {
      const m = get(s.partner_slack_id, s.partner_date);
      m.swap = 'partner'; m.swapId = s.id;
    }
  }

  return result;
}

export function lookupPending(map: Map<string, PendingMark>, slackId: string, date: string): PendingMark {
  return map.get(`${slackId}|${date}`) || EMPTY;
}
