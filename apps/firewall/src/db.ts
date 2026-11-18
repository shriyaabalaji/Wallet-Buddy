import { DatabaseSync } from "node:sqlite";

export type DB = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',      -- active | paused
  paused_reason TEXT,
  current_task TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  rules_json TEXT NOT NULL,
  hash TEXT NOT NULL,
  committed_tx TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS policies_agent ON policies(agent_id, active);
CREATE TABLE IF NOT EXISTS notify (
  agent_id TEXT PRIMARY KEY,
  phone TEXT,
  events_json TEXT NOT NULL DEFAULT '["hold"]'
);
-- Every payment request and its decision. Rows with status in SPENDING_STATUSES count against budgets.
CREATE TABLE IF NOT EXISTS requests (
  request_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  recipient TEXT NOT NULL,
  amount_micro INTEGER NOT NULL,
  category TEXT NOT NULL,
  purpose TEXT NOT NULL,
  source_context TEXT,
  outcome TEXT NOT NULL,                       -- allow | block | hold
  status TEXT NOT NULL,                        -- reserved | settled | released | held | approved | denied | expired | blocked
  rule_id TEXT,
  reason TEXT NOT NULL,
  flags_json TEXT NOT NULL DEFAULT '[]',
  violations_json TEXT NOT NULL DEFAULT '[]',
  policy_hash TEXT,
  created_at TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  settled_tx TEXT,
  arc_tx TEXT,
  arc_logged INTEGER NOT NULL DEFAULT 0,
  signed_ms INTEGER                            -- set once when the firewall signs the x402 authorization
);
CREATE INDEX IF NOT EXISTS requests_agent_time ON requests(agent_id, created_ms);
CREATE INDEX IF NOT EXISTS requests_task ON requests(agent_id, task_id);
CREATE TABLE IF NOT EXISTS holds (
  request_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  dev_token TEXT,                              -- only stored outside production, for the Home "Review" button
  expires_at TEXT NOT NULL,
  expires_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'held',         -- held | approved | denied | expired
  hold_tx TEXT,
  resolve_tx TEXT,
  token_used INTEGER NOT NULL DEFAULT 0,
  sms_sid TEXT,
  hold_error TEXT                              -- why the Arc escrow failed (null = ok or not attempted)
);
CREATE TABLE IF NOT EXISTS gateway_topups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,                           -- UTC date; at most the daily cap is deposited per day
  amount_micro INTEGER NOT NULL,
  tx TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,                    -- base64url
  counter INTEGER NOT NULL,
  transports_json TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS challenges (
  key TEXT PRIMARY KEY,                        -- "reg" or "auth:<token_hash>"
  challenge TEXT NOT NULL,
  created_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sms_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT NOT NULL,
  phone TEXT,
  body TEXT NOT NULL,
  at TEXT NOT NULL
);
`;

// "unconfirmed" = failed after the firewall signed (or the Circle CLI ran): the payment may exist, so it keeps
// counting until the owner reconciles it. It is never released automatically.
export const SPENDING_STATUSES = ["reserved", "settled", "held", "approved", "unconfirmed"] as const;
export const SPENDING_SQL = `('reserved','settled','held','approved','unconfirmed')`;

export function openDb(path: string): DB {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  try { db.exec("ALTER TABLE holds ADD COLUMN hold_error TEXT"); } catch { /* already there */ }
  try { db.exec("ALTER TABLE requests ADD COLUMN failure_reason TEXT"); } catch { /* already there */ }
  // Anomaly signals measured for each request (anomaly.ts). Old rows read as "no signals".
  try { db.exec("ALTER TABLE requests ADD COLUMN anomalies_json TEXT NOT NULL DEFAULT '[]'"); } catch { /* already there */ }
  // 1 = settled while the firewall ran with MOCK_PAYMENTS=1 (no money moved). Old rows read as real.
  try { db.exec("ALTER TABLE requests ADD COLUMN simulated INTEGER NOT NULL DEFAULT 0"); } catch { /* already there */ }
  // When the owner resolved an uncertain outcome by hand (POST /v1/payments/:id/reconcile).
  try { db.exec("ALTER TABLE requests ADD COLUMN reconciled_ms INTEGER"); } catch { /* already there */ }
  db.exec(`
    CREATE INDEX IF NOT EXISTS requests_agent_recipient ON requests(agent_id, lower(recipient));
    CREATE INDEX IF NOT EXISTS requests_agent_anomalous ON requests(agent_id, created_ms) WHERE anomalies_json <> '[]';
  `);
  return db;
}

/** Run fn inside BEGIN IMMEDIATE so concurrent writers (other processes) serialize on the write lock. */
export function immediate<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function ensureAgent(db: DB, id: string, name = id.replace(/-/g, " ")) {
  db.prepare("INSERT OR IGNORE INTO agents (id, name, created_at) VALUES (?, ?, ?)").run(id, name, new Date().toISOString());
}
