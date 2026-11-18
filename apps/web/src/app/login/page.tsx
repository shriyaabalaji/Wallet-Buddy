"use client";
import { useState, type FormEvent } from "react";

/** Only same-site paths, so ?next= can't send you elsewhere after signing in. */
function nextPath(): string {
  const n = new URLSearchParams(window.location.search).get("next") ?? "/";
  return n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/login") ? n : "/";
}

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && typeof data.error === "string" && data.error) || "Couldn't sign in.");
      window.location.assign(nextPath());
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Couldn't sign in.");
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Sign in</h1>
      <form className="panel" onSubmit={submit} aria-labelledby="login">
        <h2 id="login">Owner dashboard</h2>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        <div><button className="btn" type="submit" disabled={busy || !password}>{busy ? "Signing in…" : "Sign in"}</button></div>
        {msg && <p role="alert">{msg}</p>}
      </form>
    </>
  );
}
