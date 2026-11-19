// Who is calling the firewall. Every HTTP route declares an access class (see server.ts) and is checked here
// before its handler runs. Fail closed: a role whose credential isn't configured can't be used at all.
//
//   owner    FIREWALL_OWNER_TOKEN. Rules, pause/resume, activity, passkey enrollment. Held server-side by the
//            dashboard (apps/web proxy), never sent to a browser.
//   agent    FIREWALL_AGENT_TOKENS="research-agent=<token>,race-agent=<token>". A token is bound to ONE agent id;
//            the agentId in a request body or a payment row must match it.
//   service  FIREWALL_SERVICE_TOKEN (optional). A trusted payment service that may report /settled and /failed.
//
// Tokens travel as "Authorization: Bearer <token>". They are compared as SHA-256 digests with timingSafeEqual,
// checking every configured credential (no early exit), so timing doesn't reveal which one nearly matched.
import "./network";
import { createHash, timingSafeEqual } from "node:crypto";

export type Principal = { kind: "owner" } | { kind: "agent"; agentId: string; unauthenticated?: true } | { kind: "service" };

export interface AuthConfig {
  owner: Buffer | null;
  agents: { agentId: string; digest: Buffer }[];
  service: Buffer | null;
  /** Testnet/dev-only migration switch: agent routes accept requests with no Authorization header (old behavior). */
  allowUnauthenticatedAgents: boolean;
  /** Config problems. Each one disables the affected credential (fail closed) and is printed at startup. */
  problems: string[];
}

export const MIN_TOKEN_LENGTH = 32;
const digest = (t: string) => createHash("sha256").update(t, "utf8").digest();
const AGENT_ID = /^[A-Za-z0-9_.:-]{1,100}$/;

export function loadAuth(env: Record<string, string | undefined> = process.env): AuthConfig {
  const problems: string[] = [];
  const token = (name: string, raw: string | undefined): string | null => {
    const v = raw?.trim();
    if (!v) return null;
    if (v.length < MIN_TOKEN_LENGTH) {
      problems.push(`${name} is shorter than ${MIN_TOKEN_LENGTH} characters; ignored.`);
      return null;
    }
    return v;
  };

  const owner = token("FIREWALL_OWNER_TOKEN", env.FIREWALL_OWNER_TOKEN);
  const service = token("FIREWALL_SERVICE_TOKEN", env.FIREWALL_SERVICE_TOKEN);
  const agents: { agentId: string; token: string }[] = [];
  for (const pair of (env.FIREWALL_AGENT_TOKENS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const i = pair.indexOf("=");
    const agentId = i > 0 ? pair.slice(0, i).trim() : "";
    if (!AGENT_ID.test(agentId)) {
      problems.push("FIREWALL_AGENT_TOKENS has an entry without a valid agentId=token pair; ignored.");
      continue;
    }
    const t = token(`FIREWALL_AGENT_TOKENS[${agentId}]`, pair.slice(i + 1));
    if (!t) continue;
    if (agents.some((a) => a.agentId === agentId)) {
      problems.push(`FIREWALL_AGENT_TOKENS lists ${agentId} twice; both ignored.`);
      agents.splice(agents.findIndex((a) => a.agentId === agentId), 1);
      continue;
    }
    agents.push({ agentId, token: t });
  }

  // One token must never grant two roles: a reused token is dropped everywhere it appears.
  const all = [owner, service, ...agents.map((a) => a.token)].filter((t): t is string => t !== null);
  const reused = new Set(all.filter((t, i) => all.indexOf(t) !== i));
  if (reused.size) problems.push("The same token is configured for more than one role or agent; those credentials are disabled.");
  const keep = (t: string | null) => (t && !reused.has(t) ? digest(t) : null);

  const production = env.NODE_ENV === "production" || env.NETWORK === "mainnet";
  let allowUnauthenticatedAgents = env.FIREWALL_ALLOW_UNAUTHENTICATED_AGENTS === "1";
  if (allowUnauthenticatedAgents && production) {
    problems.push("FIREWALL_ALLOW_UNAUTHENTICATED_AGENTS is refused in production and on mainnet; agents must send a token.");
    allowUnauthenticatedAgents = false;
  }

  return {
    owner: keep(owner),
    service: keep(service),
    agents: agents.filter((a) => !reused.has(a.token)).map((a) => ({ agentId: a.agentId, digest: digest(a.token) })),
    allowUnauthenticatedAgents,
    problems,
  };
}

/** null = no credential presented; "invalid" = a credential was presented and matched nothing. */
export function authenticate(header: string | undefined, auth: AuthConfig): Principal | null | "invalid" {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!m) return "invalid";
  const presented = digest(m[1]!);
  let found: Principal | null = null;
  // Compare against every credential; no early exit.
  if (auth.owner && timingSafeEqual(presented, auth.owner)) found = { kind: "owner" };
  if (auth.service && timingSafeEqual(presented, auth.service)) found = { kind: "service" };
  for (const a of auth.agents) if (timingSafeEqual(presented, a.digest)) found = { kind: "agent", agentId: a.agentId };
  return found ?? "invalid";
}

export const authSummary = (auth: AuthConfig) => ({
  owner: Boolean(auth.owner),
  agents: auth.agents.map((a) => a.agentId),
  service: Boolean(auth.service),
  unauthenticatedAgents: auth.allowUnauthenticatedAgents,
});

export const authConfig = loadAuth();

// ---------- agent keys issued from the dashboard ----------
// The owner can create an agent and its key on the website (POST /v1/agents/:id/key). The key is shown once and
// only its SHA-256 digest is stored, in the agent_keys table. Env tokens (FIREWALL_AGENT_TOKENS) keep working.
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export function ensureAgentKeyTable(db: DatabaseSync) {
  db.exec("CREATE TABLE IF NOT EXISTS agent_keys (agent_id TEXT PRIMARY KEY, digest TEXT NOT NULL, created_at TEXT NOT NULL)");
}

/** Issue (or rotate) an agent's key. Returns the plaintext once; the old key stops working immediately. */
export function issueAgentKey(db: DatabaseSync, agentId: string): string {
  ensureAgentKeyTable(db);
  const key = `wb_${randomBytes(32).toString("base64url")}`;
  db.prepare("INSERT INTO agent_keys (agent_id, digest, created_at) VALUES (?,?,?) ON CONFLICT(agent_id) DO UPDATE SET digest=excluded.digest, created_at=excluded.created_at")
    .run(agentId, digest(key).toString("hex"), new Date().toISOString());
  return key;
}

/** The env config plus the dashboard-issued keys, read fresh so a new or rotated key works without a restart. */
export function withIssuedKeys(db: DatabaseSync, auth: AuthConfig): AuthConfig {
  ensureAgentKeyTable(db);
  const rows = db.prepare("SELECT agent_id, digest FROM agent_keys").all() as { agent_id: string; digest: string }[];
  if (!rows.length) return auth;
  return { ...auth, agents: [...auth.agents, ...rows.map((r) => ({ agentId: r.agent_id, digest: Buffer.from(r.digest, "hex") }))] };
}
