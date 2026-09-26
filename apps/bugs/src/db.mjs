// TatvaOS Bugs — the database.
//
// SQLite in one file on the container's /data volume, through Node's built-in
// node:sqlite, so the app has NO npm dependencies to install, audit or break.
// It is deliberately NOT the platform's Postgres: this tracker is Techvein's
// own tool, and keeping its tables out of the product database means it can
// never be a tenancy question and never rides a product migration.
//
// HISTORY IS APPEND-ONLY, ENFORCED BY THE DATABASE, not by remembering to.
// The triggers below refuse UPDATE and DELETE on `activity` and `attachments`,
// so a later "tidy up old comments" feature fails loudly instead of quietly
// breaking requirement 11 ("History should not be deleted").

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const STATUSES = ['pending', 'under_review', 'more_info', 'under_dev', 'fixed', 'closed', 'reopened'];
export const STATUS_LABEL = {
  pending: 'Pending',
  under_review: 'Under Review',
  more_info: 'More Information Required',
  under_dev: 'Under Development',
  fixed: 'Fixed',
  closed: 'Closed',
  reopened: 'Reopened',
};
export const PRIORITIES = ['low', 'medium', 'high', 'critical'];
export const TYPES = ['bug', 'feature'];
export const ROLES = ['admin', 'developer', 'tester'];

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  sub           TEXT UNIQUE,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL DEFAULT '',
  is_admin      INTEGER NOT NULL DEFAULT 0,
  is_developer  INTEGER NOT NULL DEFAULT 0,
  is_tester     INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  daily_summary INTEGER NOT NULL DEFAULT 1,
  admin_summary INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT
);

CREATE TABLE IF NOT EXISTS modules (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS submodules (
  id          INTEGER PRIMARY KEY,
  module_id   INTEGER NOT NULL REFERENCES modules(id),
  name        TEXT NOT NULL COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  UNIQUE (module_id, name)
);

CREATE TABLE IF NOT EXISTS issues (
  id             INTEGER PRIMARY KEY,
  module_id      INTEGER NOT NULL REFERENCES modules(id),
  submodule_id   INTEGER NOT NULL REFERENCES submodules(id),
  type           TEXT NOT NULL CHECK (type IN ('bug','feature')),
  title          TEXT NOT NULL,
  details        TEXT NOT NULL DEFAULT '',
  priority       TEXT NOT NULL CHECK (priority IN ('low','medium','high','critical')),
  status         TEXT NOT NULL CHECK (status IN ('pending','under_review','more_info','under_dev','fixed','closed','reopened')),
  reporter_id    INTEGER NOT NULL REFERENCES users(id),
  reporter_role  TEXT NOT NULL,
  assignee_id    INTEGER REFERENCES users(id),
  due_date       TEXT,
  fix_details    TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  closed_at      TEXT
);
CREATE INDEX IF NOT EXISTS ix_issues_status   ON issues(status);
CREATE INDEX IF NOT EXISTS ix_issues_assignee ON issues(assignee_id);
CREATE INDEX IF NOT EXISTS ix_issues_reporter ON issues(reporter_id);

CREATE TABLE IF NOT EXISTS activity (
  id          INTEGER PRIMARY KEY,
  issue_id    INTEGER NOT NULL REFERENCES issues(id),
  at          TEXT NOT NULL,
  actor_id    INTEGER NOT NULL REFERENCES users(id),
  actor_role  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  body        TEXT NOT NULL DEFAULT '',
  meta        TEXT
);
CREATE INDEX IF NOT EXISTS ix_activity_issue ON activity(issue_id);

CREATE TABLE IF NOT EXISTS attachments (
  id          INTEGER PRIMARY KEY,
  issue_id    INTEGER NOT NULL REFERENCES issues(id),
  activity_id INTEGER NOT NULL REFERENCES activity(id),
  name        TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  stored      TEXT NOT NULL,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  at          TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS activity_no_update BEFORE UPDATE ON activity
BEGIN SELECT RAISE(ABORT, 'issue history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS activity_no_delete BEFORE DELETE ON activity
BEGIN SELECT RAISE(ABORT, 'issue history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS attachments_no_update BEFORE UPDATE ON attachments
BEGIN SELECT RAISE(ABORT, 'attachments are append-only'); END;
CREATE TRIGGER IF NOT EXISTS attachments_no_delete BEFORE DELETE ON attachments
BEGIN SELECT RAISE(ABORT, 'attachments are append-only'); END;

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  mode       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_states (
  state      TEXT PRIMARY KEY,
  verifier   TEXT NOT NULL,
  nonce      TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per "Improve my report" call: the daily limit and the cost trail.
-- No text is stored here, only who, when, whether it worked and how long.
CREATE TABLE IF NOT EXISTS ai_usage (
  id      INTEGER PRIMARY KEY,
  at      TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  feature TEXT NOT NULL,
  ok      INTEGER NOT NULL,
  ms      INTEGER NOT NULL DEFAULT 0,
  detail  TEXT NOT NULL DEFAULT ''
);

-- The last "Summarise this issue" answer per issue, valid while no newer
-- history entry exists. Re-asking with nothing new costs no AI call.
CREATE TABLE IF NOT EXISTS ai_summaries (
  issue_id         INTEGER PRIMARY KEY REFERENCES issues(id),
  last_activity_id INTEGER NOT NULL,
  body             TEXT NOT NULL,
  at               TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mail_log (
  id      INTEGER PRIMARY KEY,
  at      TEXT NOT NULL,
  user_id INTEGER,
  subject TEXT NOT NULL,
  ok      INTEGER NOT NULL,
  detail  TEXT NOT NULL DEFAULT ''
);
`;

export function openDb(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'files'), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'bugs.db'));
  db.exec(SCHEMA);
  return db;
}

export const now = () => new Date().toISOString();

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function getSetting(db, key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

export const issueKey = (id) => 'TV-' + String(id).padStart(6, '0');
