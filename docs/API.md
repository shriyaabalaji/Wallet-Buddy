# Firewall HTTP API (apps/firewall, default `http://localhost:4000`)

All money is **integer micro-USDC** (`$1.00 = 1_000_000`). Use `formatUsd` from `@agent-firewall/policy` to display.
All responses are JSON. Errors: `{ "error": string }` with 4xx/5xx.

Demo agent id: `research-agent`. Demo task id: `nba-injuries`.

## Authentication

Every route has an access class, enforced in `apps/firewall/src/server.ts` (`authorize`) before the handler runs.
Credentials are bearer tokens (`Authorization: Bearer <token>`, ≥ 32 characters), configured in `.env.firewall`
and compared as SHA-256 digests in constant time (`apps/firewall/src/auth.ts`).

| Access | Who | Credential |
|---|---|---|
| **owner** | The dashboard's server-side proxy (`apps/web/src/app/api/fw`), scripts | `FIREWALL_OWNER_TOKEN`. Not configured → **503** on every owner route |
| **agent** | One agent. The token is bound to an agent id; the body `agentId` or the payment row must match it | `FIREWALL_AGENT_TOKENS="research-agent=<t>,race-agent=<t>"`; the agent sends its own as `FIREWALL_AGENT_TOKEN` |
| **settlement** | The agent that owns the payment (`PAYMENT_MODE=local-key` only), or a trusted payment service | agent token, or `FIREWALL_SERVICE_TOKEN`. In circle-agent-wallet mode the firewall records outcomes itself and agents get 403 (an agent `/failed` during `/pay` would un-count a real payment) |
| **link** | Whoever holds the hold token from the SMS link. Approving also needs the owner passkey | the token in the URL |
| **webhook** | Twilio | `X-Twilio-Signature` (skipped only in dev mode when `TWILIO_AUTH_TOKEN` is unset, as before) |
| **public** | Anyone | none; reveals nothing sensitive |

- No credential → **401** (`WWW-Authenticate: Bearer`). A credential that matches nothing → **401**. Valid but wrong role → **403**. An agent naming another agent, or touching another agent's `requestId` → **403** (`"Unknown payment request for this agent."`, the same answer as for an unknown id).
- A token configured twice (two roles or two agents) or shorter than 32 characters is disabled and reported at startup.
- `FIREWALL_ALLOW_UNAUTHENTICATED_AGENTS=1` is a testnet migration switch: agent and settlement routes accept requests with **no** `Authorization` header (the old demo agent). It never opens owner routes, a wrong token is still rejected, and it is refused when `NODE_ENV=production` or `NETWORK=mainnet`.
- CORS allows only `APP_BASE_URL`. Browsers don't call the firewall directly; the dashboard proxies (see below).

### Dashboard (apps/web)

The browser calls `/api/fw/<firewall path>` on the dashboard. The proxy forwards only the owner and link routes the
dashboard uses (everything else, including all `/v1/payments/*`, is 404). Owner routes need the `af_session`
cookie (HttpOnly, SameSite=Strict, HMAC-signed, 12 h) and get the owner token added **server-side**. Link routes are
forwarded without the owner token. Every POST must carry a same-site `Origin` (CSRF guard). Sign in at `/login`
(`POST /api/session { password }`, `DELETE /api/session` to sign out).

## Endpoints

| Access | Method | Path | Body | Returns |
|---|---|---|---|---|
| public | GET | `/health` | | `{ ok: true }`; with the owner token: `{ ok, signer, paymentMode, network, arc, vault, buyer, twilio, llm, passkey, auth: { owner, agents[], service, unauthenticatedAgents } }` |
| public | GET | `/v1/signer` | | `{ address, mode, network, arcNetwork }` |
| owner | GET | `/v1/agents` | | `{ agents: { id, name, status, pausedReason, currentTask, createdAt, hasPolicy, policyHash, credentialConfigured, today: Totals, budget: { daySpentMicro, dayCapMicro, dayAvailableMicro, taskSpentMicro, taskBudgetMicro, taskAvailableMicro }, pendingApprovals, anomalies24h: { requests, high } }[] }` |
| owner | POST | `/v1/agents` | `{ id, name? }` | `{ agent, wallet: null, note }`; registers the id in the firewall only (no wallet, no credential). 409 if it exists |
| owner, or agent (own id) | GET | `/v1/agents/:agentId/summary` | | `{ agent: {id, name, status: "active"\|"paused", pausedReason}, task: {id, spentMicro, budgetMicro\|null}, today: {spentMicro, capMicro\|null}, pending: HeldPayment[], recent: ActivityItem[] (10), rules: RuleView[], policy: {hash, committedTx, committedTxUrl, createdAt} \| null }`. `pending[].token` (dev mode) only for the owner. Also `totals: Totals` (today, UTC) and `series` (8 hourly buckets: `start, paidMicro, inProgressMicro, stoppedMicro, paid, inProgress, stopped`). `task.id` is null before the first request. 404 for an unregistered agent (viewing never registers one) |
| owner | POST | `/v1/agents/:agentId/pause` | `{reason?}` | `{ status: "paused" }` |
| owner | POST | `/v1/agents/:agentId/resume` | | `{ status: "active" }` |
| owner | GET | `/v1/activity?agentId=<id>\|all&status=paid\|pending\|held\|blocked\|returned\|reconcile&anomalies=1&requestId=&filter=blocked&limit=` | | `{ items: ActivityItem[] }` (newest first; items carry `agentId`, `anomalies` and `settlement` (see below); `status=reconcile` = uncertain or signed-and-silent rows; `agentId` defaults to research-agent for old callers) |
| owner | GET | `/v1/agents/:agentId/anomalies?limit=&sinceMs=` | | `{ items: { requestId, agentId, type, severity, explanation, at, measured, outcome, status, amountMicro, recipient, taskId }[] }` (one per signal, newest first) |
| owner | POST | `/v1/rules/compile` | `{ text }` | `{ rules: Rule[], views: RuleView[], ambiguities: {phrase, question}[], model: string }` |
| owner | POST | `/v1/rules/dry-run` | `{ agentId, rules, samples? }` | `{ results: { label, request, outcome, reason }[] }` (4 default samples) |
| owner | GET | `/v1/policy/:agentId` | | `{ policy, views: RuleView[], notify }` |
| owner | POST | `/v1/policy` | `{ agentId, rules, notify?: { phone, events: ("hold"\|"budget80"\|"paused")[] }, confirmed: true }` | `{ policy }`; commits hash to Arc PolicyRegistry when configured |
| owner | POST | `/v1/owner/passkey/options` | | WebAuthn registration options |
| owner | POST | `/v1/owner/passkey` | `{ response }` | `{ ok }` |
| owner | POST | `/v1/payments/:requestId/reconcile` | `{ outcome: "paid"\|"not_paid", txHash?, note? }` | `{ status }`. Only for uncertain rows (`unconfirmed`, or signed and never reported); 409 otherwise or while a `/pay` is running. `paid` → settled (still counted), `not_paid` → released |
| link | GET | `/v1/approvals/:token` | | `HeldPayment & { agentName, passkeyReady }` |
| link | POST | `/v1/approvals/:token/deny` | | `{ status: "denied", refundTx }` |
| link | POST | `/v1/approvals/:token/approve/options` | | WebAuthn assertion options |
| link | POST | `/v1/approvals/:token/approve` | `{ assertion }` | `{ status: "approved", releaseTx }` |
| agent | POST | `/v1/payments/evaluate` | `PaymentRequest` (`agentId` must be the token's agent) | `Decision & { duplicate, policyHash }` without `anomalies` (owner-only) |
| agent | POST | `/v1/payments/:requestId/pay` | `{ url }` | `{ body }` (circle-agent-wallet mode) |
| agent | POST | `/v1/payments/:requestId/sign` | `{ typedData }` | `{ signature }` (local-key mode) |
| settlement | POST | `/v1/payments/:requestId/settled` | `{ txHash? }` | `{ ok }` |
| settlement | POST | `/v1/payments/:requestId/failed` | | `{ ok }`; releases the reservation if it was never signed; after signing it becomes `unconfirmed` (counted until the owner reconciles) |
| webhook | POST | `/v1/twilio/inbound` | Twilio form post | TwiML |
| owner, or agent (own id) | POST | `/v1/optimizer/recommend` | `{ agentId, taskId?, need: { category, sku, fields? }, maxAmountMicro, baselineProviderId?, requestId? }` | `{ id, candidates[], recommended \| null, baseline, estimatedSavingsMicro, explanation, demoProvidersOnly, generatedAt, sellersUrl }`. Advice only: reads providers' live unpaid 402 quotes and pre-checks the rules; never reserves, signs or pays. Pass the `requestId` you will use for `/evaluate` to make a realized saving traceable |
| owner | GET | `/v1/optimizer/recommendations?agentId=` | | `{ items: { id, sku, providerId, amountMicro, baselineProviderId, baselineMicro, estimatedSavingsMicro, requestId, status, realizedSavingsMicro }[], realizedSavingsMicro }`. Realized only when the linked payment settled to exactly the recommended recipient and amount |

## Anomaly detection

`apps/firewall/src/anomaly.ts` measures each new payment request against the agent's own history in the `requests`
ledger, inside the same `BEGIN IMMEDIATE` transaction as the reservation and before the request's row exists (so it is
never in its own baseline). Signals are stored in `requests.anomalies_json`.

| Type | Fires when (defaults) | Severity |
|---|---|---|
| `AMOUNT_SPIKE` | ≥ 5× the median of the last 50 paid amounts and ≥ $0.50 above it (needs ≥ 5 paid requests); or ≥ $2.00 regardless | medium; high at ≥ 20× |
| `FREQUENCY_SPIKE` | ≥ 10 requests in 60 s and (with ≥ 5 requests of history in the hour before) ≥ 4× the usual per-60 s rate | medium; high at 2× both thresholds |
| `NEW_RECIPIENT` | first payment to this recipient by this agent (held requests don't count as paid) | low if allowlisted or the agent is brand new; medium otherwise; high for a raw 0x address not allowlisted |
| `RAPID_BUDGET_DEPLETION` | spend in the last 10 min incl. this payment ≥ 50% of what was left in the task, daily, weekly or monthly budget (period budgets count only spend since their own reset; ≥ $0.25; skipped if the budget blocks it anyway) | medium; high at ≥ 80% |
| `REPEATED_DENIALS` | ≥ 3 blocked requests or owner-refused holds in the last 10 min | medium; high at ≥ 6 |
| `DUPLICATE_PATTERN` | ≥ 5 earlier non-blocked requests in 10 min with the same task, recipient and amount; the agent-written purpose is reported, never matched, so rewording it doesn't hide a repeat (requestId replays stay idempotent and are not counted) | low; medium at ≥ 10 |

Every threshold can be overridden with `ANOMALY_<NAME>` (positive integers; see `ANOMALY_DEFAULTS`).
Signals never allow anything. They change a decision only through an `anomalyGuard` rule
(`{ kind: "anomalyGuard", minSeverity?: "low"|"medium"|"high" (default "high"), signals?: AnomalyType[], onViolation?: "block" }`),
which holds by default and, like every hold, loses to any block.

Agents never see measurements: `anomalies` is left out of the evaluate response and is `[]` in an agent's own
summary, and an `anomalyGuard` reason reads "Unusual activity for this agent. The owner can see the details." for the
agent (the owner sees the full explanation). Owner-only: `GET /v1/agents/:agentId/anomalies?limit=&sinceMs=`.

`Totals` = `{ paidMicro, inProgressMicro, heldMicro, stoppedMicro, counts: { requests, allowed, held, blocked, ownerApproved }, anomalies: { flaggedRequests, high }, evidence: { simulatedMicro, acceptedNoReferenceMicro, acceptedWithReferenceMicro, confirmedOnchainMicro, approvedUnrecordedMicro, pendingSignatureMicro, awaitingOutcomeMicro, uncertainMicro, uncertainCount } }`.
"Paid" = status settled (the seller accepted the payment through Circle Gateway, which settles on Arc in batches) or
approved (released from the vault). It is not an onchain settlement hash. "In progress" = reserved or unconfirmed.

**Settlement evidence** (`ActivityItem.settlement`, `Totals.evidence`; additive, `requests.status` is unchanged):
`{ state, label, reference, verifiedOnchain, simulated, needsReconciliation, reconciledByOwner }`, where `state` is
`pending_signature` (allowed, nothing signed/paid) · `awaiting_outcome` (signed or Circle CLI started, no outcome yet) ·
`uncertain` (failed after signing: may have moved money) · `simulated` (settled under `MOCK_PAYMENTS=1`, no money) ·
`accepted_no_reference` · `accepted_with_reference` (seller's reference, **not** verified onchain by the firewall) ·
`confirmed_onchain` (vault release the firewall sent and saw succeed) · `approved_unrecorded` · `held` · `not_paid`.
Only `confirmed_onchain` is verified. `/health` (owner) adds `mockPayments` and `reservationTtlMinutes`.

**Reservation timeout:** an allowed payment that is never signed or paid gives its budget back after
`RESERVATION_TTL_MINUTES` (default 15, minimum 5). Anything signed, paid-in-progress (`/pay` running) or uncertain is
never released by time; uncertain outcomes wait for an outcome report or owner reconciliation.
pause/resume return 404 for an unregistered agent.

Live updates: the dashboard polls `/v1/agents` every 5 s and `/health` every 15 s (once, in the shell), the selected agent's `summary` every 3 s, anomalies every 10 s, activity every 5 s and saved rules every 30 s. Polling pauses while the tab is hidden.
