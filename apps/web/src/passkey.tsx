"use client";

import { useEffect, useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import { api } from "@/lib/api";

/** Owner passkey enrollment. Approving a held payment needs this passkey. */
export function PasskeySetup() {
  const [ready, setReady] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    api<{ passkey: boolean }>("/health").then((h) => setReady(h.passkey)).catch(() => setReady(null));
  }, []);

  async function enroll() {
    setBusy(true);
    setMsg(null);
    try {
      const options = await api<Parameters<typeof startRegistration>[0]["optionsJSON"]>("/v1/owner/passkey/options", { method: "POST", body: {} });
      const response = await startRegistration({ optionsJSON: options });
      await api("/v1/owner/passkey", { method: "POST", body: { response } });
      setReady(true);
      setMsg(null);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Couldn't set up the passkey.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="pk">
      <div className="panel-head">
        <h2 id="pk">Passkey</h2>
        {ready !== null && <span className={`badge ${ready ? "ok" : "warn"}`}>{ready ? "Set up" : "Not set up"}</span>}
      </div>
      <p className="muted">Approves held payments with Face ID, Touch ID or a security key.</p>
      {!ready && <div><button className="btn secondary" onClick={enroll} disabled={busy}>{busy ? "Waiting for your device…" : "Set up passkey"}</button></div>}
      {msg && <p className="small" role="status">{msg}</p>}
    </section>
  );
}
