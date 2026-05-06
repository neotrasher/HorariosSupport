/**
 * Audit log: records what manager/admin actions happened, when, by whom.
 * - Manual schedule edits (add/remove/move shifts)
 * - Time-off approvals/rejections/cancellations/deletions
 * - Role assignments (planned)
 * Read-only consumer at /auditoria.
 */
import { db } from '../db';

export type AuditEntry = {
  id: number;
  ts: string;
  actor_slack_id: string | null;
  actor_name: string | null;
  action: string;
  target_kind: string | null;
  target_id: string | null;
  summary: string | null;
  payload: string | null;
};

export type AuditWritable = {
  actorSlackId: string | null;
  actorName: string | null;
  action: string;
  targetKind?: string | null;
  targetId?: string | null;
  summary?: string | null;
  payload?: any;
};

export function logAudit(opts: AuditWritable): void {
  try {
    db.prepare(`
      INSERT INTO audit_log
        (actor_slack_id, actor_name, action, target_kind, target_id, summary, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      opts.actorSlackId,
      opts.actorName,
      opts.action,
      opts.targetKind ?? null,
      opts.targetId ?? null,
      opts.summary ?? null,
      opts.payload ? JSON.stringify(opts.payload) : null
    );
  } catch (e) {
    // Audit must never break the parent action — log and swallow
    console.error('[audit] insert failed:', e);
  }
}

export type AuditFilter = {
  action?: string;
  actor?: string;
  targetKind?: string;
  targetId?: string;
  since?: string; // YYYY-MM-DD or ISO
  limit?: number;
};

export function listAudit(filter: AuditFilter = {}): AuditEntry[] {
  const where: string[] = [];
  const args: any[] = [];
  if (filter.action) { where.push('action = ?'); args.push(filter.action); }
  if (filter.actor) { where.push('actor_slack_id = ?'); args.push(filter.actor); }
  if (filter.targetKind) { where.push('target_kind = ?'); args.push(filter.targetKind); }
  if (filter.targetId) { where.push('target_id = ?'); args.push(filter.targetId); }
  if (filter.since) { where.push('ts >= ?'); args.push(filter.since); }
  const sql = `
    SELECT * FROM audit_log
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ts DESC
    LIMIT ?
  `;
  args.push(filter.limit ?? 100);
  return db.prepare(sql).all(...args) as AuditEntry[];
}

/** Distinct action keys that have entries — useful for filter dropdowns. */
export function distinctActions(): string[] {
  return (db.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action').all() as { action: string }[])
    .map(r => r.action);
}

/** Distinct actors who have entries. */
export function distinctActors(): { slack_id: string; name: string | null }[] {
  return db.prepare(`
    SELECT actor_slack_id AS slack_id, actor_name AS name
    FROM audit_log
    WHERE actor_slack_id IS NOT NULL
    GROUP BY actor_slack_id
    ORDER BY MAX(ts) DESC
    LIMIT 50
  `).all() as { slack_id: string; name: string | null }[];
}
