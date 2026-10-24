'use strict';

// SQLite storage for the Mr.Who API backend.
// Single file DB — zero-ops, matches the implementation plan's Phase 1
// database decision. Location: DB_PATH env var, else ./data/mrwho.db
//
// Driver note: this backend was built in an environment where neither
// better-sqlite3 nor sqlite3 would install (native build / prebuild
// download failures), so it uses Node's built-in `node:sqlite`
// (DatabaseSync, stable in the Node 24 runtime used here) — same SQLite
// engine, same single-file database. The exported async run/get/all
// interface is driver-shaped on purpose: swapping to better-sqlite3 on a
// machine where it installs only touches this file.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH =
  process.env.DB_PATH || path.join(__dirname, '..', 'data', 'mrwho.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

async function run(sql, params = []) {
  const info = db.prepare(sql).run(...params);
  return { lastID: Number(info.lastInsertRowid), changes: info.changes };
}

async function get(sql, params = []) {
  return db.prepare(sql).get(...params) || null;
}

async function all(sql, params = []) {
  return db.prepare(sql).all(...params);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS whatsapp_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  label TEXT,
  phone_number TEXT,
  phone_number_id TEXT,
  waba_id TEXT,
  provider TEXT NOT NULL DEFAULT 'meta_cloud_api',
  status TEXT NOT NULL DEFAULT 'pending_verification',
  verified_name TEXT,
  quality_rating TEXT,
  messaging_tier TEXT,
  account_review_status TEXT,
  last_checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  price_pkr INTEGER NOT NULL,
  period TEXT NOT NULL DEFAULT 'month',
  features TEXT NOT NULL DEFAULT '[]',
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  status TEXT NOT NULL DEFAULT 'pending_payment',
  started_at TEXT,
  current_period_end TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS health_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES whatsapp_accounts(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  check_type TEXT NOT NULL DEFAULT 'manual',
  success INTEGER NOT NULL DEFAULT 0,
  phone_status TEXT,
  quality_rating TEXT,
  messaging_tier TEXT,
  code_verification_status TEXT,
  account_review_status TEXT,
  health_status TEXT,
  health_score INTEGER,
  ban_risk TEXT,
  error TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wa_accounts_user ON whatsapp_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_health_account ON health_checks(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id);
`;

// The three Mr.Who subscription tiers (Rs 3,000 / 5,000 / 10,000 per month).
const PLAN_SEED = [
  {
    code: 'starter',
    name: 'Starter',
    price_pkr: 3000,
    period: 'month',
    sort: 1,
    features: ['1 WhatsApp number', 'Account health monitoring', 'API status checks'],
  },
  {
    code: 'business',
    name: 'Business',
    price_pkr: 5000,
    period: 'month',
    sort: 2,
    features: ['3 WhatsApp numbers', 'Account health monitoring', 'Campaigns & inbox', 'Priority checks'],
  },
  {
    code: 'premium',
    name: 'Premium',
    price_pkr: 10000,
    period: 'month',
    sort: 3,
    features: ['10 WhatsApp numbers', 'Account health monitoring', 'Campaigns, bot replies & templates', 'Team access'],
  },
];

async function init() {
  try {
    db.exec('PRAGMA journal_mode = WAL');
  } catch {
    /* WAL is an optimisation, not a requirement */
  }
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  for (const p of PLAN_SEED) {
    await run(
      `INSERT OR IGNORE INTO plans (code, name, price_pkr, period, features, sort)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [p.code, p.name, p.price_pkr, p.period, JSON.stringify(p.features), p.sort]
    );
  }
}

module.exports = { init, run, get, all, DB_PATH };
