import { db } from '../db';

export type Agent = {
  slack_id: string;
  planner_id: number;
  name: string;
  dept: string;
  role: 'agent' | 'manager';
  active: number;
};

export function getAgentBySlackId(slackId: string): Agent | undefined {
  return db.prepare('SELECT * FROM agents WHERE slack_id = ?').get(slackId) as Agent | undefined;
}

export function getAgentByPlannerId(plannerId: number): Agent | undefined {
  return db.prepare('SELECT * FROM agents WHERE planner_id = ?').get(plannerId) as Agent | undefined;
}

export function listAgents(): Agent[] {
  return db.prepare('SELECT * FROM agents WHERE active = 1 ORDER BY dept, name').all() as Agent[];
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
