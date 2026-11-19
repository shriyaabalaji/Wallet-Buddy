// Onchain proof. Reads our own contracts' events (and USDC deposits into Circle Gateway) straight from Arc and caches
// them in chain_events, so /proof shows what the chain says, not what our database claims. Arc testnet's RPC caps
// eth_getLogs at a few thousand blocks per call (measured: 5,000 ok, 10,000 "requested range too large"), so the
// indexer walks forward in chunks from the deploy block and remembers where it stopped.
//
// Metrics (payments, blocks by rule, holds, latency) come from the firewall's ledger and are labelled as such.
import { decodeEventLog, getAddress, isAddress, parseAbi, parseAbiItem, type Hex, type Log } from "viem";
import { idToBytes32 } from "@agent-firewall/policy";
import { arcPublicClient } from "./arc";
import { config, explorerTx } from "./config";
import type { DB } from "./db";

const CHUNK = 4_000n;
// One chunk at a time with a short pause: the public Arc RPC rate-limits ("Request exceeds defined limit"), and the
// funding job and vault txs share it.
const PARALLEL = 1;
const PAUSE_MS = 250;
// Block of the Deploy.s.sol broadcast (contracts/broadcast/Deploy.s.sol/5042002/run-latest.json).
const DEPLOY_BLOCK = BigInt(process.env.PROOF_FROM_BLOCK ?? 72_618_073);
const USDC = (process.env.USDC_ADDRESS ?? "0x3600000000000000000000000000000000000000") as Hex;
const GATEWAY_WALLETS = (process.env.GATEWAY_WALLET_ADDRESSES ?? "0x0077777d7EBA4688BDeF3E311b846F25870A19B9").split(",").map((s) => s.trim()).filter((a) => isAddress(a)).map((a) => getAddress(a));

const registryEvents = parseAbi([
  "event PolicyCommitted(bytes32 indexed agentId, bytes32 policyHash, uint256 timestamp)",
  "event Decision(bytes32 indexed agentId, bytes32 indexed requestId, uint8 outcome, bytes32 ruleId, uint256 amount, bytes32 policyHash)",
]);
const vaultEvents = parseAbi([
  "event Held(bytes32 indexed requestId, address indexed recipient, uint256 amount, uint64 expiresAt)",
  "event Released(bytes32 indexed requestId, address indexed recipient, uint256 amount)",
  "event Refunded(bytes32 indexed requestId, address indexed to, uint256 amount, bool expired)",
]);
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

export type ProofKind = "policy_commit" | "decision_log" | "vault_hold" | "vault_release" | "vault_refund" | "gateway_deposit";

export function ensureProofTables(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chain_events (
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      block INTEGER NOT NULL,
      at TEXT,
      kind TEXT NOT NULL,
      contract TEXT NOT NULL,
      agent_b32 TEXT,
      request_b32 TEXT,
      amount_micro INTEGER,
      detail_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (tx_hash, log_index)
    );
    CREATE INDEX IF NOT EXISTS chain_events_block ON chain_events(block DESC);
    CREATE TABLE IF NOT EXISTS chain_cursor (key TEXT PRIMARY KEY, block INTEGER NOT NULL);
  `);
}

/** Who funds Gateway balances in this deployment (treasury, Circle wallet's backing EOA, local buyer). */
function depositors(): Hex[] {
  const xs = [process.env.TREASURY_ADDRESS, process.env.CIRCLE_GATEWAY_DEPOSITOR, process.env.CIRCLE_AGENT_WALLET_ADDRESS];
  return [...new Set(xs.filter((x): x is string => Boolean(x && isAddress(x))).map((x) => getAddress(x)))];
}

// 18-decimal ERC-20 amounts in our contracts (microToErc20) vs 6-decimal USDC Transfer values.
const erc20ToMicro = (v: bigint) => Number(v / 10n ** 12n);

function rowFor(log: Log): Omit<ChainRow, "at"> | null {
  const base = { tx_hash: log.transactionHash!, log_index: log.logIndex!, block: Number(log.blockNumber), contract: getAddress(log.address) };
  try {
    if (config.arc.registryAddress && getAddress(log.address) === getAddress(config.arc.registryAddress)) {
      const e = decodeEventLog({ abi: registryEvents, data: log.data, topics: log.topics as any });
      if (e.eventName === "PolicyCommitted") return { ...base, kind: "policy_commit", agent_b32: e.args.agentId, request_b32: null, amount_micro: null, detail: { policyHash: e.args.policyHash } };
      return { ...base, kind: "decision_log", agent_b32: e.args.agentId, request_b32: e.args.requestId, amount_micro: erc20ToMicro(e.args.amount),
        detail: { outcome: ["allow", "block", "hold"][e.args.outcome] ?? String(e.args.outcome), ruleId: e.args.ruleId, policyHash: e.args.policyHash } };
    }
    if (config.arc.vaultAddress && getAddress(log.address) === getAddress(config.arc.vaultAddress)) {
      const e = decodeEventLog({ abi: vaultEvents, data: log.data, topics: log.topics as any });
      const amount = erc20ToMicro(e.args.amount);
      if (e.eventName === "Held") return { ...base, kind: "vault_hold", agent_b32: null, request_b32: e.args.requestId, amount_micro: amount, detail: { recipient: e.args.recipient, expiresAt: Number(e.args.expiresAt) } };
      if (e.eventName === "Released") return { ...base, kind: "vault_release", agent_b32: null, request_b32: e.args.requestId, amount_micro: amount, detail: { recipient: e.args.recipient } };
      return { ...base, kind: "vault_refund", agent_b32: null, request_b32: e.args.requestId, amount_micro: amount, detail: { to: e.args.to, expired: e.args.expired } };
    }
    if (getAddress(log.address) === getAddress(USDC)) {
      const e = decodeEventLog({ abi: [transferEvent], data: log.data, topics: log.topics as any });
      return { ...base, kind: "gateway_deposit", agent_b32: null, request_b32: null, amount_micro: Number(e.args.value), detail: { from: e.args.from, to: e.args.to } };
    }
  } catch {
    /* an event we don't track (ServiceChanged, OwnershipTransferred, ...) */
  }
  return null;
}

interface ChainRow { tx_hash: string; log_index: number; block: number; at: string | null; kind: ProofKind; contract: string; agent_b32: string | null; request_b32: string | null; amount_micro: number | null; detail: Record<string, unknown> }

async function logsInRange(from: bigint, to: bigint): Promise<Log[]> {
  const ours = [config.arc.registryAddress, config.arc.vaultAddress].filter(Boolean) as Hex[];
  const jobs: Promise<Log[]>[] = [];
  if (ours.length) jobs.push(arcPublicClient.getLogs({ address: ours, fromBlock: from, toBlock: to }));
  const deps = depositors();
  if (deps.length && GATEWAY_WALLETS.length) jobs.push(arcPublicClient.getLogs({ address: USDC, event: transferEvent, args: { from: deps, to: GATEWAY_WALLETS } as any, fromBlock: from, toBlock: to }) as Promise<Log[]>);
  return (await Promise.all(jobs)).flat();
}

async function withRetry<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i + 1 >= tries) throw e;
      await new Promise((r) => setTimeout(r, (/exceeds defined limit|429|rate/i.test(String((e as Error)?.message)) ? 3000 : 500) * (i + 1)));
    }
  }
}

let indexing: Promise<{ scannedTo: number; added: number }> | null = null;

/** Scan from the saved cursor to the chain head. Safe to call often; concurrent calls share one run. */
export function indexChain(db: DB, opts: { maxChunks?: number } = {}) {
  return (indexing ??= (async () => {
    try {
      ensureProofTables(db);
      if (!config.arc.registryAddress && !config.arc.vaultAddress) return { scannedTo: 0, added: 0 };
      const head = await arcPublicClient.getBlockNumber();
      const saved = db.prepare("SELECT block FROM chain_cursor WHERE key='main'").get() as { block: number } | undefined;
      let from = saved ? BigInt(saved.block) + 1n : DEPLOY_BLOCK;
      let added = 0;
      let chunks = 0;
      const insert = db.prepare(`INSERT OR IGNORE INTO chain_events (tx_hash, log_index, block, at, kind, contract, agent_b32, request_b32, amount_micro, detail_json) VALUES (?,?,?,?,?,?,?,?,?,?)`);
      const times = new Map<number, string>();
      while (from <= head && chunks < (opts.maxChunks ?? Infinity)) {
        // A batch of chunks in parallel; the cursor only advances past a batch that fully succeeded.
        const ranges: [bigint, bigint][] = [];
        for (let i = 0; i < PARALLEL && from <= head; i++, chunks++) {
          const to = from + CHUNK - 1n > head ? head : from + CHUNK - 1n;
          ranges.push([from, to]);
          from = to + 1n;
        }
        const logs = (await Promise.all(ranges.map(([a, b]) => withRetry(() => logsInRange(a, b))))).flat();
        const rows = logs.map(rowFor).filter((r): r is NonNullable<typeof r> => r !== null);
        for (const b of new Set(rows.map((r) => r.block))) {
          if (!times.has(b)) times.set(b, new Date(Number((await withRetry(() => arcPublicClient.getBlock({ blockNumber: BigInt(b) }))).timestamp) * 1000).toISOString());
        }
        db.exec("BEGIN");
        for (const r of rows) added += Number(insert.run(r.tx_hash, r.log_index, r.block, times.get(r.block) ?? null, r.kind, r.contract, r.agent_b32, r.request_b32, r.amount_micro, JSON.stringify(r.detail)).changes);
        db.prepare("INSERT INTO chain_cursor (key, block) VALUES ('main', ?) ON CONFLICT(key) DO UPDATE SET block=excluded.block").run(Number(ranges.at(-1)![1]));
        db.exec("COMMIT");
        await new Promise((r) => setTimeout(r, PAUSE_MS));
      }
      return { scannedTo: Number(from - 1n), added };
    } finally {
      indexing = null;
    }
  })());
}

const LABEL: Record<ProofKind, string> = {
  policy_commit: "Policy committed",
  decision_log: "Decision logged",
  vault_hold: "Vault hold (escrow)",
  vault_release: "Vault release (owner approved)",
  vault_refund: "Vault refund",
  gateway_deposit: "Gateway deposit",
};

/** Everything /proof shows: chain events (with our names where we can map the hashes back) + ledger metrics. */
export function proofView(db: DB, limit = 300) {
  ensureProofTables(db);
  const agentNames = new Map<string, string>();
  const agentIds = new Set<string>([
    ...(db.prepare("SELECT id FROM agents").all() as { id: string }[]).map((r) => r.id),
    ...(process.env.FIREWALL_AGENT_TOKENS ?? "").split(",").map((p) => p.split("=")[0]!.trim()).filter(Boolean),
  ]);
  for (const id of agentIds) agentNames.set(idToBytes32(id), id);
  const rows = db.prepare("SELECT * FROM chain_events ORDER BY block DESC, log_index DESC LIMIT ?").all(limit) as any[];
  const reqIndex = new Map<string, any>();
  const wanted = new Set(rows.map((r) => r.request_b32).filter(Boolean));
  if (wanted.size) for (const r of db.prepare("SELECT request_id, agent_id, recipient, purpose, outcome, status FROM requests").all() as any[]) {
    const h = idToBytes32(r.request_id);
    if (wanted.has(h)) reqIndex.set(h, r);
  }
  // Decision logs are batched: one tx carries many Decision events. Group by tx for display.
  const byTx = new Map<string, any>();
  for (const r of rows) {
    const detail = JSON.parse(r.detail_json);
    const req = r.request_b32 ? reqIndex.get(r.request_b32) : undefined;
    const key = `${r.tx_hash}:${r.kind}`;
    const item = byTx.get(key) ?? {
      tx: r.tx_hash, url: explorerTx(r.tx_hash), block: r.block, at: r.at, kind: r.kind, label: LABEL[r.kind as ProofKind], contract: r.contract,
      agent: r.agent_b32 ? (agentNames.get(r.agent_b32) ?? null) : (req?.agent_id ?? null), events: [] as any[],
    };
    item.events.push({ requestId: req?.request_id ?? null, amountUsdc: r.amount_micro == null ? null : r.amount_micro / 1e6, outcome: detail.outcome, purpose: req?.purpose ?? null, recipient: req?.recipient ?? detail.recipient ?? null, expired: detail.expired, policyHash: detail.policyHash });
    byTx.set(key, item);
  }
  const counts = db.prepare("SELECT kind, COUNT(DISTINCT tx_hash) AS txs, COUNT(*) AS events FROM chain_events GROUP BY kind").all() as any[];
  const cursor = db.prepare("SELECT block FROM chain_cursor WHERE key='main'").get() as { block: number } | undefined;
  const addr = (a: string | null | undefined) => (a ? { address: a, url: `${config.arc.explorerUrl}/address/${a}` } : null);
  return {
    network: "Arc testnet (chain 5042002)",
    explorer: config.arc.explorerUrl,
    contracts: { policyRegistry: addr(config.arc.registryAddress), approvalVault: addr(config.arc.vaultAddress), usdc: addr(USDC), gatewayWallet: addr(GATEWAY_WALLETS[0]) },
    wallets: { circleAgentWallet: addr(process.env.CIRCLE_AGENT_WALLET_ADDRESS), gatewayDepositor: addr(process.env.CIRCLE_GATEWAY_DEPOSITOR), treasury: addr(process.env.TREASURY_ADDRESS) },
    indexedThroughBlock: cursor?.block ?? null,
    onchainCounts: Object.fromEntries(counts.map((c) => [c.kind, { txs: c.txs, events: c.events }])),
    transactions: [...byTx.values()],
    metrics: ledgerMetrics(db),
  };
}

/** Numbers from the firewall's ledger (requests table), computed live. */
export function ledgerMetrics(db: DB) {
  const one = (sql: string, ...a: any[]) => db.prepare(sql).get(...a) as any;
  const paid = one("SELECT COUNT(*) n, COALESCE(SUM(amount_micro),0) s FROM requests WHERE status='settled' AND simulated=0");
  const decisions = one("SELECT COUNT(*) n FROM requests");
  const byOutcome = Object.fromEntries((db.prepare("SELECT outcome, COUNT(*) n FROM requests GROUP BY outcome").all() as any[]).map((r) => [r.outcome, r.n]));
  const blockedByRule = (db.prepare("SELECT COALESCE(rule_id,'(none)') rule, COUNT(*) n FROM requests WHERE outcome='block' GROUP BY rule ORDER BY n DESC").all() as any[]).map((r) => ({ rule: r.rule, count: r.n }));
  const holds = Object.fromEntries((db.prepare("SELECT status, COUNT(*) n FROM holds GROUP BY status").all() as any[]).map((r) => [r.status, r.n]));
  const lat = one("SELECT COUNT(decision_ms) n, AVG(decision_ms) avg, MAX(decision_ms) max FROM requests WHERE decision_ms IS NOT NULL");
  const lats = (db.prepare("SELECT decision_ms FROM requests WHERE decision_ms IS NOT NULL ORDER BY decision_ms").all() as any[]).map((r) => r.decision_ms as number);
  const p95 = lats.length ? lats[Math.min(lats.length - 1, Math.floor(lats.length * 0.95))] : null;
  const flagged = one("SELECT COUNT(*) n FROM requests WHERE anomalies_json <> '[]' OR flags_json <> '[]'");
  const dailyTopup = Number(process.env.GATEWAY_DAILY_TOPUP_USDC ?? 5);
  return {
    source: "firewall ledger (requests/holds tables), live",
    paymentsSettled: paid.n,
    totalSpentUsdc: paid.s / 1e6,
    decisions: decisions.n,
    outcomes: { allow: byOutcome.allow ?? 0, block: byOutcome.block ?? 0, hold: byOutcome.hold ?? 0 },
    blockedByRule,
    holds: { held: holds.held ?? 0, approved: holds.approved ?? 0, denied: holds.denied ?? 0, expired: holds.expired ?? 0 },
    flaggedRequests: flagged.n,
    decisionLatencyMs: { samples: lat.n, avg: lat.avg == null ? null : Math.round(lat.avg * 10) / 10, p95, max: lat.max },
    worstCaseLoss: {
      perDayUsdc: dailyTopup,
      explanation: `Testnet: the paying wallet's Gateway balance is topped up by at most $${dailyTopup}/day (gateway_topups ledger). That bounds a hijacked agent or a leaked payer credential to $${dailyTopup}/day; the owner's rules usually bound it far lower. It does NOT bound a compromised firewall host, which also holds the treasury and vault-owner keys (README: threat model).`,
    },
  };
}
