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

  // Now safe to create indexes that reference the new columns
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_punches_shift
      ON punches(slack_id, shift_date, shift_id);
  `);
}

if (require.main === module) {
  migrate();
  console.log('Migration done.');
}
