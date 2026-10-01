'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const INITIAL_SITES = [
  'Monal Imarat',
  'Monal Rawalpindi',
  'Monal Murree',
  'Asian Awak Bahria Town',
  'Asian Awak Murree',
  'Jungle Story',
  'M1 Track',
];

const DEFAULT_SETTINGS = {
  maintenance_due_window_days: '7',
};

let instance = null;

function nowIso() {
  return new Date().toISOString();
}

function open(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

  const ts = nowIso();
  const siteCount = db.prepare('SELECT COUNT(*) AS n FROM sites').get().n;
  if (siteCount === 0) {
    const ins = db.prepare('INSERT INTO sites (name, created_at, updated_at) VALUES (?, ?, ?)');
    for (const name of INITIAL_SITES) ins.run(name, ts, ts);
  }
  const setIns = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) setIns.run(k, v);
  return db;
}

/** Initialise the shared connection (idempotent). */
function init(dbPath) {
  if (!instance) instance = open(dbPath || require('../config').databasePath);
  return instance;
}

function db() {
  return instance || init();
}

function close() {
  if (instance) {
    instance.close();
    instance = null;
  }
}

/** Run fn inside a transaction; nested calls join the outer transaction. */
let depth = 0;
function tx(fn) {
  const d = db();
  if (depth > 0) return fn(d);
  depth++;
  d.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(d);
    d.exec('COMMIT');
    return result;
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  } finally {
    depth--;
  }
}

function getSetting(key) {
  const row = db().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

module.exports = { init, db, close, tx, nowIso, getSetting, setSetting, INITIAL_SITES };
