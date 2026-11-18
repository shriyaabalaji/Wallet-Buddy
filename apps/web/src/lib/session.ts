// Server-only: the dashboard's owner session. Never import this from a "use client" file.
//
// The browser never holds the firewall owner token. It holds an HttpOnly, SameSite=Strict session cookie
// (an HMAC-signed expiry, keyed by DASHBOARD_SESSION_SECRET); the /api/fw proxy checks it and adds the owner
// token server-side. Login is a single owner password (DASHBOARD_PASSWORD). Fail closed: if either variable is
// missing or too short, nobody can log in.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "af_session";
export const SESSION_TTL_S = 12 * 3600;
const MIN_SECRET = 32;
const MIN_PASSWORD = 12;

type Env = Record<string, string | undefined>;

const secret = (env: Env) => {
  const s = env.DASHBOARD_SESSION_SECRET?.trim();
  return s && s.length >= MIN_SECRET ? s : null;
};
const password = (env: Env) => {
  const p = env.DASHBOARD_PASSWORD;
  return p && p.length >= MIN_PASSWORD ? p : null;
};
export const loginConfigured = (env: Env = process.env) => Boolean(secret(env) && password(env));

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest();
const mac = (key: string, data: string) => createHmac("sha256", key).update(data).digest("base64url");
const same = (a: string, b: string) => timingSafeEqual(sha(a), sha(b));

export function checkPassword(given: unknown, env: Env = process.env): boolean {
  const p = password(env);
  return Boolean(p && secret(env) && typeof given === "string" && same(given, p));
}

/** "v1.<expiry unix s>.<nonce>.<hmac>" */
export function createSession(env: Env = process.env, now = Date.now()): string {
  const key = secret(env);
  if (!key) throw new Error("DASHBOARD_SESSION_SECRET is not configured.");
  const body = `v1.${Math.floor(now / 1000) + SESSION_TTL_S}.${randomBytes(16).toString("base64url")}`;
  return `${body}.${mac(key, body)}`;
}

export function verifySession(value: string | undefined, env: Env = process.env, now = Date.now()): boolean {
  const key = secret(env);
  if (!key || !value) return false;
  const i = value.lastIndexOf(".");
  if (i < 0) return false;
  const body = value.slice(0, i);
  const [v, exp] = body.split(".");
  if (v !== "v1" || !same(value.slice(i + 1), mac(key, body))) return false;
  return Number(exp) * 1000 > now;
}

export const cookieOptions = (secure: boolean) => ({ httpOnly: true, sameSite: "strict" as const, secure, path: "/", maxAge: SESSION_TTL_S });

/**
 * CSRF guard for state-changing requests: the browser's Origin must be this dashboard. SameSite=Strict already keeps
 * the cookie off cross-site requests; this is the second check. DASHBOARD_ORIGIN pins the expected origin (use it
 * behind a tunnel or reverse proxy); otherwise the request's own Host is used.
 */
export function sameOrigin(req: Request, env: Env = process.env): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const pinned = env.DASHBOARD_ORIGIN?.trim().replace(/\/$/, "");
  if (pinned) return origin === pinned;
  const host = req.headers.get("host"); // not x-forwarded-host: a client can set that
  try {
    return Boolean(host) && new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Tiny in-memory brute-force brake for the login route (per server process). */
const failures: number[] = [];
export function loginThrottled(now = Date.now()): boolean {
  while (failures.length && failures[0]! < now - 5 * 60_000) failures.shift();
  return failures.length >= 10;
}
export const recordLoginFailure = (now = Date.now()) => void failures.push(now);
