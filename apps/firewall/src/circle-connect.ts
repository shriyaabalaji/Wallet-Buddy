// Connect a Circle Agent Wallet from the dashboard (Settings → Wallet). Drives Circle's CLI on the firewall host (the
// same CLI and session that `circle services pay` uses in payer.ts) with its documented non-interactive login:
//   circle wallet login <email> --type agent [--testnet] --init   → Circle emails a one-time code
//   circle wallet login --request <id> --otp <code>               → session saved in the firewall user's ~/.circle-cli
// then finds the Agent Wallet on Arc and the backing EOA that owns its Gateway balance, and saves both (wallet.ts).
// The owner types the emailed code into the dashboard themselves. Circle's own warning applies: never give an AI agent
// access to the inbox. The CLI's request id never leaves the firewall. Circle's Terms are accepted only on the owner's
// explicit OK. Agents can't reach any of this (owner routes), and the demo agent runs with an empty HOME, so it never
// sees the CLI session either.
import { execFile } from "node:child_process";
import { getAddress, isAddress } from "viem";
import { network } from "./network";
import type { DB } from "./db";
import { circleWallet, connectedWallet, paymentMode, saveConnectedWallet } from "./wallet";

export class ConnectError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const CLI = () => process.env.CIRCLE_CLI_BIN ?? "circle";
const CHAIN = () => process.env.CIRCLE_CHAIN ?? (network === "mainnet" ? "ARC" : "ARC-TESTNET");
const TESTNET_FLAG = () => (network === "mainnet" ? [] : ["--testnet"]);

type CliResult = { ok: true; data: any } | { ok: false; missing?: boolean; code?: string; message: string };

/** Run the CLI with JSON output. Never throws: a missing binary, a timeout or a CLI error comes back as ok: false. */
export function runCli(args: string[], { json = true, timeoutMs = 60_000 } = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(CLI(), json ? [...args, "-o", "json"] : args, { timeout: timeoutMs, maxBuffer: 4 << 20, env: { ...process.env, CIRCLE_VERSION_CHECK: "off" } }, (err, stdout, stderr) => {
      if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return resolve({ ok: false, missing: true, message: "Circle's CLI isn't installed on the firewall machine." });
      const out = stdout.toString().trim();
      if (json) {
        try {
          const parsed = JSON.parse(out) as { data?: unknown; error?: { code?: string; message?: string } };
          if (parsed.error) return resolve({ ok: false, code: parsed.error.code, message: parsed.error.message ?? "Circle's CLI reported an error." });
          if (!err && parsed.data !== undefined) return resolve({ ok: true, data: parsed.data });
        } catch { /* fall through to the raw text */ }
      } else if (!err) {
        return resolve({ ok: true, data: out });
      }
      const text = (stderr.toString() || out || (err as Error | null)?.message || "Circle's CLI failed.").trim().split("\n")[0]!.replace(/^Error:\s*/, "");
      resolve({ ok: false, message: text.slice(0, 300) });
    });
  });
}

// ---------- the owner's pending login (one at a time, in memory only) ----------

type Pending = { requestId: string; email: string; expiresAt: number; attempts: number };
let pending: Pending | null = null;
let lastSentAt = 0;
const CODE_TTL_MS = 10 * 60_000;
const RESEND_MS = 30_000;
const MAX_ATTEMPTS = 5;

/** Test hook: forget the pending login and the resend throttle. */
export function resetConnectState() {
  pending = null;
  lastSentAt = 0;
}

const EMAIL = /^[^\s@-][^\s@]{0,63}@[^\s@]+\.[^\s@]{2,}$/;
/** As Circle's CLI accepts it: the 6 digits, or the full code with its anti-phishing prefix (B1X-123456). */
const OTP = /^(?:[A-Za-z0-9]{1,8}-)?\d{6}$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{4,200}$/;

export type WalletStatus = {
  network: typeof network;
  chain: string;
  paymentMode: ReturnType<typeof paymentMode>;
  /** The wallet paying now: connected from the dashboard, or from the environment. */
  wallet: { address: string | null; depositor: string | null; source: "dashboard" | "env" };
  connected: { email: string; connectedAt: string } | null;
  cli: { installed: boolean; version: string | null };
  terms: { accepted: boolean; termsOfUseUrl: string; privacyPolicyUrl: string } | null;
  /** The CLI's session on this network: who is signed in, if anyone. */
  session: { signedIn: boolean; email: string | null; expired: boolean } | null;
  pending: { email: string; expiresAt: string } | null;
};

export async function walletStatus(): Promise<WalletStatus> {
  // Each CLI start takes ~2 s, so the three reads run in parallel (wallet status just fails until Terms are accepted).
  const [version, t, s] = await Promise.all([
    runCli(["--version"], { json: false, timeoutMs: 20_000 }),
    runCli(["terms", "show"]),
    runCli(["wallet", "status", "--type", "agent"]),
  ]);
  const installed = !(!version.ok && version.missing);
  let terms: WalletStatus["terms"] = null;
  let session: WalletStatus["session"] = null;
  if (installed) {
    if (t.ok) terms = { accepted: Boolean(t.data.accepted), termsOfUseUrl: String(t.data.termsOfUseUrl), privacyPolicyUrl: String(t.data.privacyPolicyUrl) };
    if (terms?.accepted) {
      const env = s.ok ? s.data?.[network] : null;
      session = env && env.tokenStatus !== "NOT_LOGGED_IN"
        ? { signedIn: env.tokenStatus === "VALID", email: typeof env.email === "string" ? env.email : null, expired: env.tokenStatus === "EXPIRED" }
        : { signedIn: false, email: null, expired: false };
    }
  }
  if (pending && Date.now() > pending.expiresAt) pending = null;
  const c = connectedWallet();
  return {
    network,
    chain: CHAIN(),
    paymentMode: paymentMode(),
    wallet: circleWallet(),
    connected: c ? { email: c.email, connectedAt: c.connectedAt } : null,
    cli: { installed, version: version.ok ? String(version.data).trim().slice(0, 40) : null },
    terms,
    session,
    pending: pending ? { email: pending.email, expiresAt: new Date(pending.expiresAt).toISOString() } : null,
  };
}

/** Accept Circle's CLI Terms. Only called when the owner ticked "I accept" in the dashboard. */
export async function acceptTerms(): Promise<void> {
  const r = await runCli(["terms", "accept"]);
  if (!r.ok) throw new ConnectError(r.message, r.missing ? 503 : 502);
}

/** Step 1: Circle emails the owner a one-time code. */
export async function sendCode(emailInput: unknown): Promise<{ email: string; expiresAt: string }> {
  const email = typeof emailInput === "string" ? emailInput.trim() : "";
  if (email.length > 254 || !EMAIL.test(email)) throw new ConnectError("Enter a valid email address.");
  const wait = lastSentAt + RESEND_MS - Date.now();
  if (wait > 0) throw new ConnectError(`Wait ${Math.ceil(wait / 1000)} seconds before asking for another code.`, 429);
  lastSentAt = Date.now();
  const r = await runCli(["wallet", "login", email, "--type", "agent", ...TESTNET_FLAG(), "--init"]);
  if (!r.ok) {
    lastSentAt = 0;
    throw new ConnectError(r.code === "PERMISSION_DENIED" ? "Accept Circle's Terms first." : r.message, r.missing ? 503 : r.code === "PERMISSION_DENIED" ? 409 : 502);
  }
  const requestId = String(r.data?.message ?? "").match(/--request\s+(\S+)/)?.[1];
  if (!requestId || !REQUEST_ID.test(requestId)) throw new ConnectError("Circle's CLI didn't return a login request. Try again.", 502);
  pending = { requestId, email, expiresAt: Date.now() + CODE_TTL_MS, attempts: 0 };
  return { email, expiresAt: new Date(pending.expiresAt).toISOString() };
}

/** Step 2: the owner's code completes the CLI login; then the wallet is found and connected. */
export async function verifyCode(db: DB, codeInput: unknown) {
  if (!pending || Date.now() > pending.expiresAt) {
    pending = null;
    throw new ConnectError("That code request expired. Send a new code.", 409);
  }
  const code = typeof codeInput === "string" ? codeInput.trim().replace(/\s+/g, "") : "";
  if (!OTP.test(code)) throw new ConnectError("Enter the code from Circle's email, like B1X-123456 or 123456.");
  pending.attempts++;
  if (pending.attempts > MAX_ATTEMPTS) {
    pending = null;
    throw new ConnectError("Too many tries. Send a new code.", 429);
  }
  const r = await runCli(["wallet", "login", "--request", pending.requestId, "--otp", code]);
  if (!r.ok) throw new ConnectError(/invalid|expired/i.test(r.message) ? "That code didn't work. Check it and try again, or send a new one." : r.message, r.missing ? 503 : 400);
  const email = pending.email;
  pending = null;
  return connectFromSession(db, email);
}

/** Use the CLI's current session: find the Agent Wallet on Arc and its Gateway backing EOA, and make it the payer. */
export async function connectFromSession(db: DB, emailHint?: string) {
  const chain = CHAIN();
  const list = await runCli(["wallet", "list", "--type", "agent", "--chain", chain]);
  if (!list.ok) throw new ConnectError(list.code === "AUTH_REQUIRED" ? "Circle's CLI isn't signed in on this network. Sign in with your email first." : list.message, list.missing ? 503 : 409);
  const wallets = (Array.isArray(list.data?.wallets) ? list.data.wallets : []).filter((w: any) => typeof w?.address === "string" && isAddress(w.address));
  if (!wallets.length) throw new ConnectError(`No Agent Wallet on ${chain} for this Circle account.`, 404);
  const address = getAddress(wallets[0].address);
  const bal = await runCli(["gateway", "balance", "--address", address, "--chain", chain]);
  const eoa = bal.ok ? bal.data?.backingEOA : null;
  if (typeof eoa !== "string" || !isAddress(eoa)) throw new ConnectError(bal.ok ? "Circle didn't report the wallet's Gateway account." : bal.message, 502);
  let email = emailHint ?? null;
  if (!email) {
    const s = await runCli(["wallet", "status", "--type", "agent"]);
    email = s.ok && typeof s.data?.[network]?.email === "string" ? s.data[network].email : "unknown";
  }
  saveConnectedWallet(db, { address, depositor: getAddress(eoa), email: email!, network, connectedAt: new Date().toISOString() });
  return walletStatus();
}

/** Stop paying from the dashboard-connected wallet (back to the environment). The CLI session is left signed in. */
export async function disconnect(db: DB) {
  saveConnectedWallet(db, null);
  pending = null;
  return walletStatus();
}
