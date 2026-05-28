import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from './config';

const dir = path.dirname(config.dbPath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      slack_id   TEXT PRIMARY KEY,
      planner_id INTEGER NOT NULL UNIQUE,
      name       TEXT NOT NULL,
      dept       TEXT NOT NULL,
      role       TEXT NOT NULL DEFAULT 'agent',
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS punches (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      slack_id    TEXT NOT NULL,
      type        TEXT NOT NULL,
      ts          TEXT NOT NULL,
      source      TEXT NOT NULL DEFAULT 'button',
      note        TEXT,
      shift_date  TEXT,
      shift_id    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_punches_user_ts
      ON punches(slack_id, ts);

    CREATE TABLE IF NOT EXISTS alerts_sent (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      slack_id   TEXT NOT NULL,
      shift_date TEXT NOT NULL,
      shift_id   TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      ts         TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(slack_id, shift_date, shift_id, alert_type)
    );

    CREATE TABLE IF NOT EXISTS shift_messages (
      slack_id    TEXT NOT NULL,
      shift_date  TEXT NOT NULL,
      shift_id    TEXT NOT NULL,
      channel_id  TEXT NOT NULL,
      message_ts  TEXT NOT NULL,
      PRIMARY KEY(slack_id, shift_date, shift_id)
    );

    -- Date-based schedule model (replaces (cycle, day, shift_id) abstraction).
    -- Each row is an absolute-date assignment, supporting per-date overrides
    -- (vacaciones aprobadas, trades, partial shifts).
    CREATE TABLE IF NOT EXISTS schedule_entries (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      date              TEXT NOT NULL,           -- YYYY-MM-DD (UTC date of shift start)
      dept              TEXT NOT NULL,
      shift_id          TEXT NOT NULL,
      planner_id        INTEGER NOT NULL,
      custom_start_hour REAL,                    -- override (UTC hour, fractional ok)
      custom_end_hour   REAL,                    -- override (>=24 means next day)
      note              TEXT,
      source            TEXT NOT NULL DEFAULT 'import'  -- import | swap | manual
    );
    CREATE INDEX IF NOT EXISTS idx_se_date ON schedule_entries(date);
    CREATE INDEX IF NOT EXISTS idx_se_planner_date ON schedule_entries(planner_id, date);

    CREATE TABLE IF NOT EXISTS days_off_entries (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      planner_id INTEGER NOT NULL,
      date       TEXT NOT NULL,
      reason     TEXT,                           -- 'time_off' | 'rest' | null
      UNIQUE(planner_id, date)
    );
    CREATE INDEX IF NOT EXISTS idx_doe_date ON days_off_entries(date);

    CREATE TABLE IF NOT EXISTS time_off_requests (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      requester_slack_id  TEXT NOT NULL,
      type                TEXT NOT NULL,            -- 'permiso' | 'vacaciones'
      start_date          TEXT NOT NULL,            -- YYYY-MM-DD inclusive
      end_date            TEXT NOT NULL,            -- YYYY-MM-DD inclusive
      reason              TEXT,
      status              TEXT NOT NULL,            -- 'pending' | 'approved' | 'rejected' | 'cancelled'
      approver_slack_id   TEXT,
      approval_at         TEXT,
      rejection_reason    TEXT,
      approval_dm_targets TEXT,                     -- JSON array of {slack_id, channel, ts}
      requester_dm_channel TEXT,
      requester_dm_ts     TEXT,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      source              TEXT NOT NULL DEFAULT 'web' -- 'web' | 'bot'
    );
    CREATE INDEX IF NOT EXISTS idx_tor_requester ON time_off_requests(requester_slack_id, status);
    CREATE INDEX IF NOT EXISTS idx_tor_status ON time_off_requests(status);

    CREATE TABLE IF NOT EXISTS swap_requests (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      requester_slack_id TEXT NOT NULL,
      partner_slack_id   TEXT NOT NULL,
      requester_date     TEXT NOT NULL,
      partner_date       TEXT NOT NULL,
      requester_snapshot TEXT NOT NULL,
      partner_snapshot   TEXT NOT NULL,
      note               TEXT,
      status             TEXT NOT NULL,
      partner_response_at TEXT,
      partner_dm_channel TEXT,
      partner_dm_ts      TEXT,
      approval_dm_channel TEXT,
      approval_dm_ts     TEXT,
      approval_dm_targets TEXT,
      approver_slack_id  TEXT,
      approval_at        TEXT,
      rejection_reason   TEXT,
      executed_at        TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_swap_status
      ON swap_requests(status);
    CREATE INDEX IF NOT EXISTS idx_swap_requester
      ON swap_requests(requester_slack_id, status);
    CREATE INDEX IF NOT EXISTS idx_swap_partner
      ON swap_requests(partner_slack_id, status);
  `);

  // Schema upgrades for existing DBs: add columns if missing (must run before indexes)
  const cols = db.prepare("PRAGMA table_info(punches)").all() as { name: string }[];
  const hasCol = (n: string) => cols.some(c => c.name === n);
  if (!hasCol('shift_date')) db.exec('ALTER TABLE punches ADD COLUMN shift_date TEXT');
  if (!hasCol('shift_id'))   db.exec('ALTER TABLE punches ADD COLUMN shift_id TEXT');

  // Extended HR fields on agents (operational + sensitive)
  const agentCols = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
  const hasAgentCol = (n: string) => agentCols.some(c => c.name === n);
  // Operational
  if (!hasAgentCol('admin_user'))            db.exec('ALTER TABLE agents ADD COLUMN admin_user TEXT');
  if (!hasAgentCol('position'))              db.exec('ALTER TABLE agents ADD COLUMN position TEXT');
  if (!hasAgentCol('email_company'))         db.exec('ALTER TABLE agents ADD COLUMN email_company TEXT');
  if (!hasAgentCol('email_personal'))        db.exec('ALTER TABLE agents ADD COLUMN email_personal TEXT');
  if (!hasAgentCol('start_date'))            db.exec('ALTER TABLE agents ADD COLUMN start_date TEXT');
  if (!hasAgentCol('end_date'))              db.exec('ALTER TABLE agents ADD COLUMN end_date TEXT');
  if (!hasAgentCol('last_evaluation_date'))  db.exec('ALTER TABLE agents ADD COLUMN last_evaluation_date TEXT');
  if (!hasAgentCol('next_evaluation_date'))  db.exec('ALTER TABLE agents ADD COLUMN next_evaluation_date TEXT');
  if (!hasAgentCol('birthdate'))             db.exec('ALTER TABLE agents ADD COLUMN birthdate TEXT');
  if (!hasAgentCol('address'))               db.exec('ALTER TABLE agents ADD COLUMN address TEXT');
  if (!hasAgentCol('phone'))                 db.exec('ALTER TABLE agents ADD COLUMN phone TEXT');
  // Sensitive (admin only)
  if (!hasAgentCol('id_number'))                  db.exec('ALTER TABLE agents ADD COLUMN id_number TEXT');
  if (!hasAgentCol('salary_current'))             db.exec('ALTER TABLE agents ADD COLUMN salary_current REAL');
  if (!hasAgentCol('salary_previous'))            db.exec('ALTER TABLE agents ADD COLUMN salary_previous REAL');
  if (!hasAgentCol('salary_new'))                 db.exec('ALTER TABLE agents ADD COLUMN salary_new REAL');
  if (!hasAgentCol('last_adjustment_pct'))        db.exec('ALTER TABLE agents ADD COLUMN last_adjustment_pct REAL');
  if (!hasAgentCol('last_salary_adjustment_date')) db.exec('ALTER TABLE agents ADD COLUMN last_salary_adjustment_date TEXT');
  if (!hasAgentCol('holiday_day_amount'))         db.exec('ALTER TABLE agents ADD COLUMN holiday_day_amount REAL');
  // Vacation tracking
  if (!hasAgentCol('vacation_days_per_year'))     db.exec('ALTER TABLE agents ADD COLUMN vacation_days_per_year INTEGER');
  // Per-agent timezone for displaying shift hours in their local time
  if (!hasAgentCol('timezone'))                   db.exec('ALTER TABLE agents ADD COLUMN timezone TEXT');

  // Now safe to create indexes that reference the new columns
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_punches_shift
      ON punches(slack_id, shift_date, shift_id);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by TEXT
    );

    -- Single-row JSON store for the cycle-based planner template (4 cycles × dept × day × shift).
    -- The planner editor reads/writes the whole blob; applying to specific dates is a separate step.
    CREATE TABLE IF NOT EXISTS planner_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schedule_json TEXT NOT NULL,
      days_off_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by TEXT
    );

    -- Audit log: who did what and when. Records manual schedule edits,
    -- time-off resolutions, role changes, etc.
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      actor_slack_id TEXT,
      actor_name TEXT,
      action TEXT NOT NULL,            -- e.g. shift.add, shift.remove, shift.move, timeoff.approve
      target_kind TEXT,                -- 'agent', 'request', 'setting', 'shift', etc.
      target_id TEXT,                  -- planner_id, request id, agent slack_id, setting key, etc.
      summary TEXT,                    -- human-readable one-liner
      payload TEXT                     -- JSON with structured details
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_slack_id, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_kind, target_id, ts DESC);

    -- ICS calendar feed tokens: one token per agent, public URL /cal/:token.ics
    CREATE TABLE IF NOT EXISTS agent_calendar_tokens (
      slack_id    TEXT PRIMARY KEY,
      token       TEXT NOT NULL UNIQUE,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cal_token ON agent_calendar_tokens(token);

    -- Daily notification dedup: prevents resending birthday/evaluation alerts
    -- if the bot restarts on the same day. Key = (kind, target, date).
    CREATE TABLE IF NOT EXISTS daily_notifications (
      kind      TEXT NOT NULL,        -- 'birthday' | 'evaluation_reminder'
      target    TEXT NOT NULL,        -- agent slack_id (subject of the notification)
      date      TEXT NOT NULL,        -- YYYY-MM-DD (UTC) when sent
      sent_at   TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (kind, target, date)
    );

    -- Break reservations: agents can reserve a 30-min slot for their break
    -- to avoid collisions within their (dept, shift, date) cohort. Optional —
    -- agents can also take break without reserving if the cap allows.
    CREATE TABLE IF NOT EXISTS break_reservations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      slack_id      TEXT NOT NULL,
      shift_date    TEXT NOT NULL,            -- YYYY-MM-DD (UTC, shift start date)
      dept          TEXT NOT NULL,            -- 'L1' | 'L2'
      shift_id      TEXT NOT NULL,            -- 'M' | 'T' | 'E' | 'N'
      slot_start    TEXT NOT NULL,            -- ISO UTC timestamp of slot start
      duration_min  INTEGER NOT NULL DEFAULT 30, -- 30 | 60 (1 or 2 slots)
      status        TEXT NOT NULL DEFAULT 'active', -- active | taken | expired | cancelled
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_breakres_cohort
      ON break_reservations(shift_date, dept, shift_id, status);
    CREATE INDEX IF NOT EXISTS idx_breakres_user
      ON break_reservations(slack_id, shift_date, status);
  `);
}

if (require.main === module) {
  migrate();
  console.log('Migration done.');
}
