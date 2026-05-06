import { db } from '../db';
import { config } from '../config';

export type AgentRole = 'agent' | 'manager' | 'admin';

export type Agent = {
  slack_id: string;
  planner_id: number;
  name: string;
  dept: string;
  role: AgentRole;
  active: number;
  // Operational HR
  admin_user: string | null;
  position: string | null;
  email_company: string | null;
  email_personal: string | null;
  start_date: string | null;
  end_date: string | null;
  last_evaluation_date: string | null;
  next_evaluation_date: string | null;
  birthdate: string | null;
  address: string | null;
  phone: string | null;
  // Sensitive (admin only)
  id_number: string | null;
  salary_current: number | null;
  salary_previous: number | null;
  salary_new: number | null;
  last_adjustment_pct: number | null;
  last_salary_adjustment_date: string | null;
  holiday_day_amount: number | null;
  vacation_days_per_year: number | null;
  timezone: string | null;
  created_at: string;
};

export const OPERATIONAL_FIELDS = [
  'name', 'dept', 'admin_user', 'position', 'email_company', 'email_personal',
  'start_date', 'end_date', 'last_evaluation_date', 'next_evaluation_date',
  'birthdate', 'address', 'phone',
  'vacation_days_per_year', 'timezone'
] as const;

export const SENSITIVE_FIELDS = [
  'id_number', 'salary_current', 'salary_previous', 'salary_new',
  'last_adjustment_pct', 'last_salary_adjustment_date', 'holiday_day_amount'
] as const;

export type OperationalField = typeof OPERATIONAL_FIELDS[number];
export type SensitiveField = typeof SENSITIVE_FIELDS[number];

export function getAgentBySlackId(slackId: string): Agent | undefined {
  return db.prepare('SELECT * FROM agents WHERE slack_id = ?').get(slackId) as Agent | undefined;
}

export function getAgentByPlannerId(plannerId: number): Agent | undefined {
  return db.prepare('SELECT * FROM agents WHERE planner_id = ?').get(plannerId) as Agent | undefined;
}

export function listAgents(): Agent[] {
  return db.prepare('SELECT * FROM agents WHERE active = 1 ORDER BY dept, name').all() as Agent[];
}

export function listAllAgents(includeInactive: boolean = false): Agent[] {
  const sql = includeInactive
    ? 'SELECT * FROM agents ORDER BY active DESC, dept, name'
    : 'SELECT * FROM agents WHERE active = 1 ORDER BY dept, name';
  return db.prepare(sql).all() as Agent[];
}

export function linkAgent(slackId: string, plannerId: number, name: string, dept: string) {
  db.prepare(`
    INSERT INTO agents (slack_id, planner_id, name, dept)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(slack_id) DO UPDATE SET
      planner_id = excluded.planner_id,
      name = excluded.name,
      dept = excluded.dept,
      active = 1
  `).run(slackId, plannerId, name, dept);
}

export function unlinkAgent(slackId: string) {
  db.prepare('UPDATE agents SET active = 0 WHERE slack_id = ?').run(slackId);
}

export function setActive(slackId: string, active: boolean) {
  db.prepare('UPDATE agents SET active = ? WHERE slack_id = ?').run(active ? 1 : 0, slackId);
}

/**
 * Update only the listed fields. The caller is responsible for filtering by role
 * (operational vs sensitive). Empty strings are converted to NULL.
 */
export function updateAgentFields(slackId: string, fields: Record<string, string | number | null>) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const setClause = keys.map(k => `${k} = ?`).join(', ');
  const values = keys.map(k => {
    const v = fields[k];
    if (v === '' || v === undefined) return null;
    return v;
  });
  db.prepare(`UPDATE agents SET ${setClause} WHERE slack_id = ?`).run(...values, slackId);
}

/**
 * Recompute config.managerSlackIds and config.adminSlackIds as the union of
 * (env defaults at startup, kept in `envManagerSlackIds`/`envAdminSlackIds`)
 * and any agent rows whose role column is 'manager' or 'admin'. Called on
 * startup and after the /agentes role edit. Mutates `config` in place so all
 * downstream code that does `config.managerSlackIds.includes(x)` keeps working.
 */
export function applyDbRoles() {
  const c: any = config;
  // Snapshot env defaults the first time we run, so subsequent reloads union
  // against the original env (not against the previous DB-merged list).
  if (!c.envManagerSlackIds) c.envManagerSlackIds = [...c.managerSlackIds];
  if (!c.envAdminSlackIds)   c.envAdminSlackIds   = [...c.adminSlackIds];

  const dbManagers = db.prepare("SELECT slack_id FROM agents WHERE role = 'manager' AND active = 1").all() as { slack_id: string }[];
  const dbAdmins   = db.prepare("SELECT slack_id FROM agents WHERE role = 'admin' AND active = 1").all() as { slack_id: string }[];

  c.managerSlackIds = Array.from(new Set([...(c.envManagerSlackIds as string[]), ...dbManagers.map(r => r.slack_id)]));
  c.adminSlackIds   = Array.from(new Set([...(c.envAdminSlackIds   as string[]), ...dbAdmins.map(r => r.slack_id)]));
  // Admin implies manager for permission checks
  for (const a of c.adminSlackIds) {
    if (!c.managerSlackIds.includes(a)) c.managerSlackIds.push(a);
  }
}

export function createAgent(opts: {
  slackId: string;
  plannerId: number;
  name: string;
  dept: string;
  role?: AgentRole;
}) {
  db.prepare(`
    INSERT INTO agents (slack_id, planner_id, name, dept, role, active)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(opts.slackId, opts.plannerId, opts.name, opts.dept, opts.role || 'agent');
}
