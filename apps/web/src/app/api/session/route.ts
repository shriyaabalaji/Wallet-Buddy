// Owner login/logout for the dashboard. Sets or clears the HttpOnly session cookie; never returns a token.
import { NextResponse } from "next/server";
import { SESSION_COOKIE, checkPassword, cookieOptions, createSession, loginConfigured, loginThrottled, recordLoginFailure, sameOrigin, verifySession } from "../../../lib/session";
import { sessionCookie } from "../../../lib/proxy";

export const dynamic = "force-dynamic";

const secure = (req: Request) => new URL(req.url).protocol === "https:";

export async function GET(req: Request) {
  return NextResponse.json({ authenticated: verifySession(sessionCookie(req)), configured: loginConfigured() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "Cross-site request refused." }, { status: 403 });
  if (!loginConfigured()) return NextResponse.json({ error: "Sign-in isn't set up on this dashboard (DASHBOARD_PASSWORD, DASHBOARD_SESSION_SECRET)." }, { status: 503 });
  if (loginThrottled()) return NextResponse.json({ error: "Too many attempts. Wait a few minutes and try again." }, { status: 429 });
  const body = (await req.json().catch(() => null)) as { password?: unknown } | null;
  if (!checkPassword(body?.password)) {
    recordLoginFailure();
    return NextResponse.json({ error: "That password isn't right." }, { status: 401 });
  }
  const res = NextResponse.json({ authenticated: true });
  res.cookies.set(SESSION_COOKIE, createSession(), cookieOptions(secure(req)));
  return res;
}

export async function DELETE(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "Cross-site request refused." }, { status: 403 });
  const res = NextResponse.json({ authenticated: false });
  res.cookies.set(SESSION_COOKIE, "", { ...cookieOptions(secure(req)), maxAge: 0 });
  return res;
}
