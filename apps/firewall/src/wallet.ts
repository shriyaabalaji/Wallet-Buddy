// Which wallet pays, decided at runtime. The environment (PAYMENT_MODE, CIRCLE_AGENT_WALLET_ADDRESS,
// CIRCLE_GATEWAY_DEPOSITOR) is the default. A Circle Agent Wallet the owner connects from the dashboard
// (Settings → Wallet; circle-connect.ts) overrides it and is kept in owner_settings, so it survives restarts.
// Disconnecting returns to the environment. Only the owner can change it (owner routes in server.ts).
import "./network";
import { getAddress, isAddress, type Address } from "viem";
import { network, type Network } from "./network";
import type { DB } from "./db";

export type PaymentMode = "local-key" | "circle-agent-wallet";

/** PAYMENT_MODE from the environment: Circle Agent Wallet unless local-key is asked for. */
export const envPaymentMode: PaymentMode = process.env.PAYMENT_MODE === "local-key" ? "local-key" : "circle-agent-wallet";

const addrOrNull = (s: string | undefined): Address | null => (s && isAddress(s) ? getAddress(s) : null);
const ENV_WALLET = {
  address: addrOrNull(process.env.CIRCLE_AGENT_WALLET_ADDRESS),
  depositor: addrOrNull(process.env.CIRCLE_GATEWAY_DEPOSITOR),
};

export type ConnectedWallet = {
  /** The Agent Wallet (smart-contract account) that `circle services pay` pays from. */
  address: Address;
  /** Its backing EOA: whose Circle Gateway balance the payments draw on. */
  depositor: Address;
  email: string;
  network: Network;
  connectedAt: string;
};

let connected: ConnectedWallet | null = null;
const KEY = "circle_wallet";

function ensure(db: DB) {
  db.exec("CREATE TABLE IF NOT EXISTS owner_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
}

/** Load the dashboard-connected wallet for this network (a wallet saved on the other network is ignored). */
export function loadConnectedWallet(db: DB): ConnectedWallet | null {
  ensure(db);
  const row = db.prepare("SELECT value FROM owner_settings WHERE key=?").get(KEY) as { value: string } | undefined;
  connected = null;
  if (!row) return null;
  try {
    const w = JSON.parse(row.value) as ConnectedWallet;
    if (w.network === network && isAddress(w.address) && isAddress(w.depositor)) {
      connected = { ...w, address: getAddress(w.address), depositor: getAddress(w.depositor) };
    }
  } catch { /* unreadable row: fall back to the environment */ }
  return connected;
}

export function saveConnectedWallet(db: DB, w: ConnectedWallet | null) {
  ensure(db);
  if (w) {
    db.prepare("INSERT INTO owner_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(KEY, JSON.stringify(w));
  } else {
    db.prepare("DELETE FROM owner_settings WHERE key=?").run(KEY);
  }
  connected = w;
}

export const connectedWallet = () => connected;

/** The payment mode in force now: a connected Circle Agent Wallet always pays through Circle. */
export const paymentMode = (): PaymentMode => (connected ? "circle-agent-wallet" : envPaymentMode);

/** The Circle Agent Wallet in force now (connected, else from the environment); either field may be null. */
export const circleWallet = (): { address: Address | null; depositor: Address | null; source: "dashboard" | "env" } =>
  connected ? { address: connected.address, depositor: connected.depositor, source: "dashboard" } : { ...ENV_WALLET, source: "env" };
