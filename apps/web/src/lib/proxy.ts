// Server-only: the dashboard's path to the firewall (used by app/api/fw/[...path]/route.ts).
//
// Only firewall routes the dashboard actually uses are forwarded; everything else is a 404, so a browser session
// can never reach the agent payment routes. Owner routes need a valid session cookie and get the owner token
// added here. Approval-link routes stay public (the hold token in the URL is the credential, approving still
// needs the passkey) and are forwarded WITHOUT the owner token.
import { SESSION_COOKIE, sameOrigin, verifySession } from "./session";

type Env = Record<string, string | undefined>;
type Access = "owner" | "link";

const ROUTES: [method: string, path: RegExp, access: Access][] = [
  ["GET", /^\/health$/, "owner"],
  ["GET", /^\/v1\/agents$/, "owner"],
  ["POST", /^\/v1\/agents$/, "owner"],
  ["GET", /^\/v1\/agents\/[^/]+\/summary$/, "owner"],
  ["GET", /^\/v1\/agents\/[^/]+\/anomalies$/, "owner"],
  ["POST", /^\/v1\/agents\/[^/]+\/(pause|resume|key|notify)$/, "owner"],
  ["GET", /^\/v1\/activity$/, "owner"],
  ["POST", /^\/v1\/rules\/(compile|dry-run)$/, "owner"],
  ["GET", /^\/v1\/policy\/[^/]+$/, "owner"],
  ["POST", /^\/v1\/policy$/, "owner"],
  ["POST", /^\/v1\/owner\/passkey(\/options)?$/, "owner"],
  ["POST", /^\/v1\/payments\/[^/]+\/reconcile$/, "owner"],
  ["POST", /^\/v1\/optimizer\/recommend$/, "owner"],
  ["GET", /^\/v1\/optimizer\/recommendations$/, "owner"],
  ["GET", /^\/v1\/proof$/, "link"], // public onchain proof page
  ["GET", /^\/v1\/approvals\/[^/]+$/, "link"],
  ["POST", /^\/v1\/approvals\/[^/]+\/(deny|approve\/options|approve)$/, "link"],
];
const MAX_BODY = 100_000;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

/** Rebuild the firewall path from route segments, re-encoding each one so "..", "/" or "?" can't change the target. */
export function classify(method: string, segments: string[]): { path: string; access: Access } | null {
  if (segments.length === 0 || segments.some((s) => s === "" || s === "." || s === "..")) return null;
  const path = "/" + segments.map(encodeURIComponent).join("/");
  const hit = ROUTES.find(([m, re]) => m === method && re.test(path));
  return hit ? { path, access: hit[2] } : null;
}

export function sessionCookie(req: Request): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === SESSION_COOKIE) return v.join("=");
  }
  return undefined;
}

export async function proxy(req: Request, segments: string[], env: Env = process.env, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const route = classify(req.method, segments);
  if (!route) return json(404, { error: "not found" });
  if (req.method !== "GET" && !sameOrigin(req, env)) return json(403, { error: "Cross-site request refused." });

  const headers: Record<string, string> = {};
  if (route.access === "owner") {
    if (!verifySession(sessionCookie(req), env)) return json(401, { error: "Please sign in." });
    const owner = env.FIREWALL_OWNER_TOKEN?.trim();
    if (!owner) return json(503, { error: "The dashboard isn't configured with FIREWALL_OWNER_TOKEN." });
    headers.Authorization = `Bearer ${owner}`;
  }

  let body: string | undefined;
  if (req.method !== "GET") {
    body = await req.text();
    if (body.length > MAX_BODY) return json(413, { error: "Request too large." });
    headers["Content-Type"] = "application/json";
  }

  const target = (env.FIREWALL_URL ?? "http://localhost:4000").replace(/\/$/, "") + route.path + new URL(req.url).search;
  let res: Response;
  try {
    res = await fetchImpl(target, { method: req.method, headers, body, cache: "no-store", redirect: "manual" });
  } catch {
    return json(502, { error: "Can't reach the firewall right now." });
  }
  // Pass only the status and JSON body back; no firewall headers reach the browser.
  return new Response(await res.text(), { status: res.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
