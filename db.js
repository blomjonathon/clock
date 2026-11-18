// SQLite storage using Node's built-in driver (Node 22.13+), so there is nothing native to compile.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'clock.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS students (
    id         INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    pin        TEXT    NOT NULL UNIQUE,
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS entries (
    id         INTEGER PRIMARY KEY,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    clock_in   TEXT    NOT NULL,   -- ISO 8601 UTC
    clock_out  TEXT,               -- NULL while clocked in
    in_dist    REAL,               -- metres from school at clock in
    out_dist   REAL,               -- metres from school at clock out
    note       TEXT,
    edited_at  TEXT                -- set when an admin changes the entry
  );

  CREATE INDEX IF NOT EXISTS idx_entries_student ON entries(student_id, clock_in);
  CREATE INDEX IF NOT EXISTS idx_entries_in      ON entries(clock_in);

  -- The one phone/browser each student is allowed to clock in from. Only a hash of the device key is stored.
  CREATE TABLE IF NOT EXISTS devices (
    id         INTEGER PRIMARY KEY,
    student_id INTEGER NOT NULL UNIQUE REFERENCES students(id) ON DELETE CASCADE,
    token_hash TEXT    NOT NULL UNIQUE,
    label      TEXT,
    created_at TEXT    NOT NULL,
    last_seen  TEXT
  );

  -- One-time codes the teacher hands out to set up a student's phone.
  CREATE TABLE IF NOT EXISTS setup_codes (
    student_id INTEGER PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
    code_hash  TEXT    NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL
  );

  -- Admin logins. Only a hash of each token is stored, so a copied database can't be used to sign in.
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT    PRIMARY KEY,
    pw_fp      TEXT    NOT NULL,   -- fingerprint of the password used. Changing the password ends every session.
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const DEFAULT_SETTINGS = {
  title: 'Student Time Clock',
  school_lat: '',
  school_lng: '',
  radius_m: '150',
  geofence_enabled: 'true',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
};

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = { ...DEFAULT_SETTINGS };
  for (const r of rows) s[r.key] = r.value;
  return s;
}

function setSettings(patch) {
  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  for (const [k, v] of Object.entries(patch)) {
    if (k in DEFAULT_SETTINGS) stmt.run(k, String(v));
  }
  return getSettings();
}

module.exports = { db, getSettings, setSettings };
