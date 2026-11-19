// The seller registry: the names agents put in `recipient` (e.g. "sportsfeed") and the wallet each one is paid at.
// Payments to a name only go out if the seller's 402 asks to be paid at the address registered here (payer.ts,
// signer.ts), and vault holds escrow to it (arc.ts). The owner manages it from Settings → Sellers.
//
// SELLER_ADDRESSES in .env.firewall still works: on startup its entries are added once, as if the owner had added them.
// A seller the owner removes stays removed (soft delete), so a restart doesn't bring it back.
import { getAddress, isAddress, type Hex } from "viem";
import type { DB } from "./db";

export interface Seller { name: string; address: Hex; url: string | null; addedAt: string; source: "dashboard" | "env" }

const NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;
/** Loaded registry (name → seller); null until loadSellers runs, in which case resolution falls back to the env var. */
let registry: Map<string, Seller> | null = null;

function ensure(db: DB) {
  db.exec(`CREATE TABLE IF NOT EXISTS sellers (
    name TEXT PRIMARY KEY, address TEXT NOT NULL, url TEXT, added_at TEXT NOT NULL, source TEXT NOT NULL, removed INTEGER NOT NULL DEFAULT 0
  )`);
}

/** "sportsfeed=0x…,oddsapi=0x…" → pairs, skipping malformed entries. */
export function parseSellerEnv(raw: string | undefined): [string, Hex][] {
  return (raw ?? "").split(",").map((p) => p.trim().split("=") as [string, string])
    .filter(([n, a]) => n && a && NAME.test(n.toLowerCase()) && isAddress(a))
    .map(([n, a]) => [n.toLowerCase(), getAddress(a)]);
}

/** Create the table, add any SELLER_ADDRESSES entries not seen before, and load the registry into memory. */
export function loadSellers(db: DB, env = process.env.SELLER_ADDRESSES) {
  ensure(db);
  const add = db.prepare("INSERT OR IGNORE INTO sellers (name, address, url, added_at, source) VALUES (?, ?, NULL, ?, 'env')");
  for (const [n, a] of parseSellerEnv(env)) add.run(n, a, new Date().toISOString());
  refresh(db);
}

function refresh(db: DB) {
  const rows = db.prepare("SELECT name, address, url, added_at, source FROM sellers WHERE removed=0 ORDER BY name").all() as any[];
  registry = new Map(rows.map((r) => [r.name, { name: r.name, address: r.address as Hex, url: r.url, addedAt: r.added_at, source: r.source }]));
}

export function listSellers(db: DB): Seller[] {
  if (!registry) loadSellers(db);
  return [...registry!.values()];
}

export class SellerError extends Error {}

export function upsertSeller(db: DB, input: { name?: unknown; address?: unknown; url?: unknown }): Seller {
  ensure(db);
  const name = typeof input.name === "string" ? input.name.trim().toLowerCase() : "";
  if (!NAME.test(name)) throw new SellerError("Name: lowercase letters, numbers, dots, dashes or underscores, up to 40 characters.");
  if (/^0x[0-9a-f]{40}$/.test(name)) throw new SellerError("Use a name, not an address. Agents can already pay a raw address if your rules allow it.");
  const address = typeof input.address === "string" ? input.address.trim() : "";
  if (!isAddress(address)) throw new SellerError("That isn't a valid wallet address (0x followed by 40 hex characters).");
  let url: string | null = null;
  if (typeof input.url === "string" && input.url.trim()) {
    try { const u = new URL(input.url.trim()); if (!/^https?:$/.test(u.protocol)) throw 0; url = u.toString().replace(/\/$/, ""); }
    catch { throw new SellerError("URL must start with http:// or https://."); }
  }
  db.prepare(`INSERT INTO sellers (name, address, url, added_at, source, removed) VALUES (?, ?, ?, ?, 'dashboard', 0)
    ON CONFLICT(name) DO UPDATE SET address=excluded.address, url=excluded.url, source='dashboard', removed=0`)
    .run(name, getAddress(address), url, new Date().toISOString());
  refresh(db);
  return registry!.get(name)!;
}

export function removeSeller(db: DB, name: string): boolean {
  ensure(db);
  const r = db.prepare("UPDATE sellers SET removed=1 WHERE name=? AND removed=0").run(name.toLowerCase());
  refresh(db);
  return Number(r.changes) > 0;
}

/**
 * The wallet a recipient is paid at: a raw 0x address is itself; a name must be registered. Before the registry is
 * loaded (scripts and tests that never start the server) the env var is used directly.
 */
export function sellerAddress(recipient: string): Hex | null {
  if (/^0x[0-9a-fA-F]{40}$/.test(recipient)) return recipient as Hex;
  if (registry) return registry.get(recipient.toLowerCase())?.address ?? null;
  return new Map(parseSellerEnv(process.env.SELLER_ADDRESSES)).get(recipient.toLowerCase()) ?? null;
}
