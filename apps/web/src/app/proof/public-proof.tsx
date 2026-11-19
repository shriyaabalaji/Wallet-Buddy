"use client";
// Public onchain proof for judges (no login). The signed-in dashboard shows the same components as Activity's
// "Onchain" tab (src/proof.tsx), inside the normal shell.
import Link from "next/link";
import { Brand } from "@/components";
import { ProofAddresses, ProofMetrics, ProofTransactions, useProof } from "@/proof";

export default function PublicProof() {
  const { data, err } = useProof();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <Brand />
        <Link className="btn secondary" href="/">Dashboard</Link>
      </div>
      <h1>Onchain proof</h1>
      <p className="muted">Every row below is a real Arc testnet transaction, read from the chain and linked to the explorer.{data?.indexedThroughBlock ? ` Indexed through block ${data.indexedThroughBlock.toLocaleString()}.` : ""} Updates every 15 seconds.</p>
      {err && <div className="callout attention" role="alert"><p>Can&apos;t reach the firewall right now ({err}).</p></div>}
      {!data && !err && <p className="muted" role="status">Loading…</p>}
      {data && <ProofMetrics m={data.metrics} />}
      {data && <ProofAddresses data={data} />}
      {data && <ProofTransactions data={data} />}
    </div>
  );
}
