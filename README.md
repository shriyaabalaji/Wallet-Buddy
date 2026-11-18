# Agent Firewall

**Spending rules for AI agents, written in plain English and enforced outside the agent.** Payments that need a human are held on Arc until the owner approves them with a passkey. Every decision is logged onchain.

Built for UBC 2026, Agentic Payments & AI track, on Circle Nanopayments (x402) and Arc testnet.

## What it does

- **Rules in plain English.** You type "Up to $10 for this task, $5 a day. Text me before anything over $1. Only pay sportsfeed and oddsapi." Claude compiles that into structured rules. You see each rule as a sentence, run a quick test on sample payments, and then confirm. Rules are never applied silently. Vague phrases such as "if it goes crazy" are flagged, not guessed.
- **The firewall is the only signer.** The agent has no private key. To pay an x402 seller, it asks the firewall. The firewall signs the Gateway `TransferWithAuthorization` only if the payee, amount, chain and contract match a payment it has already allowed. Each request gets one signature.
- **Held payments.** An unknown recipient, or a payment above your threshold, is held in `ApprovalVault` on Arc and you get a text message. Reply **NO** to cancel it. Approving requires your passkey; replying "YES" by text does nothing. If you do nothing, the payment is refunded after 15 minutes.
- **No race conditions.** Each payment is evaluated and its budget reserved in a single SQLite `BEGIN IMMEDIATE` transaction. Two $0.80 requests against $1.00 always produce one allow and one block, including across separate processes (tested).
- **Audit trail.** The policy hash is committed to `PolicyRegistry`, and decisions are batch-logged there as events.

## Architecture

```
 ┌───────────────┐ 1. GET resource            ┌──────────────────────┐
 │  Demo agent   │ ─────────────────────────▶ │ x402 sellers (demo)  │
 │  (no keys)    │ ◀──── 402 + requirements ─ │ Circle Gateway mw    │
 └──────┬────────┘                            └──────────▲───────────┘
        │ 2. PaymentRequest                               │ 5. Payment-Signature
        ▼                                                 │
 ┌──────────────────────────────────────────┐             │
 │ Firewall service (apps/firewall)         │             │
 │  policy engine + SQLite ledger           │ 3. allow ───┘ 4. sign typed data
 │  atomic reserve · signer (buyer key)     │    (only if it matches the reservation)
 │  Twilio SMS · WebAuthn · Arc logger      │
 └──────┬──────────────────────┬────────────┘
        │ hold                 │ commit hash / log decisions
        ▼                      ▼
 ┌────────────────┐    ┌──────────────────┐        Gateway batches the
 │ ApprovalVault  │    │ PolicyRegistry   │        authorizations and
 │ hold/approve/  │    │ events only      │        settles on Arc
 │ deny/expire    │    └──────────────────┘
 └────────────────┘
```

| Path | What it is |
|---|---|
| `packages/policy` | Pure rule evaluation (9 rule kinds), canonical policy hash, money normalization (Arc native 18 decimals vs. ERC-20 6 decimals), plain-English descriptions |
| `apps/firewall` | HTTP API (`docs/API.md`), SQLite ledger, rules compiler, dry run, signer, holds, SMS, passkeys, Arc adapter |
| `apps/web` | Next.js site: Home, Rules, Activity, and the `/a/[token]` approve page |
| `apps/sellers` | Demo x402 sellers. Two are honest; one endpoint returns a prompt injection |
| `apps/agent` | Demo agent: normal buying, the race, and a simulated hijack |
| `contracts` | Foundry: `PolicyRegistry`, `ApprovalVault`, with tests (including reentrancy and fuzz tests) |
| `docs/RESEARCH.md` | Verified answers on Circle, Arc and x402, with sources |

## Run it

```bash
npm install
npm test                 # policy + firewall unit tests (incl. multi-process race)
npm run test:contracts   # forge tests
npm run demo:local       # full demo with throwaway keys, mock seller settlement, no funds needed
```

Interactive, with three terminals:

```bash
cp .env.firewall.example .env.firewall && chmod 600 .env.firewall   # ALL secrets; firewall only
cp .env.agent.example .env.agent         # no secrets
cp .env.sellers.example .env.sellers     # payee addresses only
npm run dev:firewall     # :4000  (prints which integrations are live)
npm run dev:sellers      # :4200
npm run dev:web          # :3000  → set rules on /rules, then:
npm run dev:agent -- all 5
```

To go live on Arc testnet:

1. Fund keys at faucet.circle.com.
2. Deploy the contracts: `cd contracts && forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast --private-key $SERVICE_PRIVATE_KEY`.
3. Set `REGISTRY_ADDRESS` and `VAULT_ADDRESS`.
4. From the treasury, `approve` the vault to spend USDC.
5. Set up the Circle Agent Wallet that pays (the default payer). Do the email code yourself; never give an agent your inbox:
   ```bash
   npm install -g @circle-fin/cli@1.4.0
   circle terms accept                                    # read https://agents.circle.com/terms-of-use first
   circle wallet login you@example.com --testnet          # email OTP
   circle wallet list --type agent --chain ARC-TESTNET    # → put it in .env.firewall as CIRCLE_AGENT_WALLET_ADDRESS
   ```
   The firewall tops up that wallet's Gateway balance from the treasury, at most `GATEWAY_DAILY_TOPUP_USDC` (default $5) per UTC day. To fund it by hand instead: `circle wallet fund --address <W> --chain ARC-TESTNET` (faucet), then `circle gateway deposit --amount 5 --address <W> --chain ARC-TESTNET --method direct`.
   Fallback with no Circle login: `PAYMENT_MODE=local-key` and a `BUYER_PRIVATE_KEY` that the firewall signs with.
6. Fund the treasury (the service key) and set `MOCK_PAYMENTS=0`.
7. Before demos, `npm run vault:approve -w @agent-firewall/firewall -- 20`. Every hold uses up vault allowance, even if refunded.

**Mainnet** runs only when `NETWORK=mainnet` is set in the shell. It reads `.env.firewall.mainnet`, refuses `local-key`, and uses one demo seller (`NETWORK=mainnet npm run mainnet -w @agent-firewall/sellers`). Setup is in `HANDOFF.md` §15.

**Where to see the Agent Wallets:**
- `circle wallet list --type agent --chain ARC-TESTNET` (or `--chain ARC`)
- `circle wallet balance --address <W> --chain ARC-TESTNET`
- `circle gateway balance --address <W> --chain ARC-TESTNET`
- The address on the Arc explorer.

We haven't found a documented Circle web console page for Agent Wallets.

Without an `LLM_API_KEY`, the compiler falls back to an offline parser that handles the demo phrasings. The API reports `model: "offline-parser"`.

## Owner controls, authentication, anomalies and the optimizer

**Authentication** (`apps/firewall/src/auth.ts`, details in `docs/API.md`):
- **Owner token** (`FIREWALL_OWNER_TOKEN`): rules, pause/resume, activity, reconciliation, passkey enrollment. Only the dashboard's server holds it. The browser gets an HttpOnly session cookie after `DASHBOARD_PASSWORD`, and `apps/web/src/lib/proxy.ts` forwards an allowlisted set of owner routes.
- **Agent tokens** (`FIREWALL_AGENT_TOKENS="agent-id=token,…"`): each is bound to one agent id. It can evaluate and pay for that agent only. It can't change rules, resume itself, or read owner data.
- **Service token** (`FIREWALL_SERVICE_TOKEN`, optional): may report `/settled` and `/failed`.
- `FIREWALL_ALLOW_UNAUTHENTICATED_AGENTS=1` is a testnet migration switch. It is refused in production and on mainnet.

**Spending policies** (`packages/policy`, deterministic, the same code for dry runs and live decisions):
- `taskBudget`
- `periodBudget` (day / week / month, UTC)
- `perTxLimit`
- `approvalThreshold` (hold for your passkey)
- `allowlist` (unknown recipients hold by default, or block with `onViolation: "block"`)
- `categories`
- `timeWindow`
- `rateLimit` (can pause the agent)
- `anomalyGuard`
- emergency pause

Budgets are reserved atomically (`BEGIN IMMEDIATE`). Tests cover two processes racing, 6 processes × 10 requests on one task, and the same across 60 different tasks for the daily cap. A reservation that is never paid is released after `RESERVATION_TTL_MINUTES`. Uncertain outcomes stay counted until the owner reconciles them (`/v1/payments/:id/reconcile`).

**Anomaly detection** (`apps/firewall/src/anomaly.ts`): explainable signals measured against the agent's own ledger history, computed inside the reservation transaction:
- `AMOUNT_SPIKE`
- `FREQUENCY_SPIKE`
- `NEW_RECIPIENT`
- `RAPID_BUDGET_DEPLETION`
- `REPEATED_DENIALS`
- `DUPLICATE_PATTERN`

With little history they fall back to absolute thresholds (`ANOMALY_*` overrides). Signals never allow anything. They only change a decision through an `anomalyGuard` rule (hold, or block), and a hold never overrides a block. Agents never see the measured values (that would teach a hijacked agent to stay just under them); the owner does.

**Multi-agent dashboard** (`apps/web`, owner sign-in):
- an agent switcher, with per-agent overview: today's paid, in-progress and stopped money, budgets, an 8-hour chart, waiting approvals, rules, and "Locked on Arc" verification;
- an "Unusual activity" panel;
- funding and Arc status;
- "Price check";
- activity filters: agent, status, flagged, request id, needs reconciliation;
- settlement-evidence labels: simulated, seller accepted / no reference, unverified, confirmed onchain;
- agent registration and passkey approvals.

**Payment optimizer** (`apps/firewall/src/optimizer.ts`): recommends the cheapest *suitable* provider for a capability.
- **Advice only.** It never reserves, signs or pays. The agent still goes through `/evaluate`, and the payer re-checks the seller's live 402 (payee and amount) before paying, so the optimizer can't authorize anything the firewall would reject.
- **Eligibility:**
  - same SKU, category and output fields;
  - a live 402 quote under `OPTIMIZER_QUOTE_TTL_MS` old;
  - the 402 payee matches the configured recipient;
  - the live price matches the configured price;
  - within `maxAmountMicro`;
  - a rules pre-check returns *allow* (a hold is not auto-recommended).
- **Choosing:** cheapest wins. Ties go to measured quote latency, but only if every tied provider was measured; otherwise to provider id.
- **Providers are our own demo sellers** (`statline` $0.05 and `sportsfeed` $0.02, the same injury report). There are no comparable external x402 providers on Arc testnet. **Estimated** saving = the live price difference against the usual provider, only if that provider was itself an eligible option. **Realized** saving = recorded only when the linked payment settled to exactly the recommended recipient and amount.

### Real vs demo, at a glance
| | Real | Demo / simulated |
|---|---|---|
| Network | Arc **testnet** by default. Mainnet code exists behind `NETWORK=mainnet`, untested pending funding | — |
| Payments | `MOCK_PAYMENTS=0`: real x402 nanopayments through Circle Gateway, paid from a Circle Agent Wallet (verified: Circle reports the transfers `completed`) | `npm run demo:local`: throwaway keys, the seller accepts any signature |
| Who enforces | Our firewall rules on every network. Circle Agent Wallet policies ($/day, allowlist) are **mainnet-only** and not part of the testnet demo | — |
| Sellers | Real x402 / Gateway middleware | All sellers are ours (disclosed). The "compromised" seller is scripted |
| "Settled" | The firewall marks a payment settled when Circle's CLI returns and the seller delivers. Gateway settles with sellers in batches later, so the dashboard labels this "seller accepted, no transaction reference" unless an onchain reference exists | — |
| Savings | Realized only with a settled, matching payment | Estimated from live quotes of our two demo sellers |

### Configuration (names only; values live in gitignored files)
- **`.env.firewall`:**
  - Network: `NETWORK` (shell only), `ARC_RPC_URL`, `ARC_CHAIN_ID`, `ARC_EXPLORER_URL`, `USDC_ADDRESS`
  - Keys and contracts: `SERVICE_PRIVATE_KEY`, `OWNER_PRIVATE_KEY`, `OWNER_ADDRESS`, `TREASURY_ADDRESS`, `REGISTRY_ADDRESS`, `VAULT_ADDRESS`
  - Payer: `PAYMENT_MODE`, `CIRCLE_AGENT_WALLET_ADDRESS`, `CIRCLE_GATEWAY_DEPOSITOR`, `CIRCLE_CHAIN`, `CIRCLE_CLI_BIN`, `PAY_NETWORK`, `PAY_URL_PREFIXES`, `BUYER_PRIVATE_KEY` (local-key only), `GATEWAY_WALLET_ADDRESSES`
  - Sellers: `SELLER_ADDRESSES`, `SELLERS_URL`
  - Funding: `GATEWAY_DAILY_TOPUP_USDC`, `BUYER_GAS_RESERVE_USDC`, `FUNDING`
  - Auth: `FIREWALL_OWNER_TOKEN`, `FIREWALL_AGENT_TOKENS`, `FIREWALL_SERVICE_TOKEN`, `FIREWALL_ALLOW_UNAUTHENTICATED_AGENTS`
  - Server: `FIREWALL_PORT`, `FIREWALL_DB`, `FIREWALL_PUBLIC_URL`, `APP_BASE_URL`, `WEBAUTHN_RP_ID`, `HOLD_MINUTES`, `RESERVATION_TTL_MINUTES`, `MOCK_PAYMENTS`
  - Optimizer: `OPTIMIZER_QUOTE_TTL_MS`
  - Text messages: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `OWNER_PHONE`
  - Rules compiler: `LLM_API_KEY`
- **`.env.firewall.mainnet`:** mainnet overrides.
- **`apps/web/.env.local`:** `FIREWALL_URL`, `FIREWALL_OWNER_TOKEN`, `DASHBOARD_PASSWORD`, `DASHBOARD_SESSION_SECRET`, `DASHBOARD_ORIGIN`.
- **`.env.agent`:** `FIREWALL_URL`, `SELLERS_URL`, `FIREWALL_AGENT_TOKEN`, `AGENT_ID`, `TASK_ID`, `MOCK_PAYMENTS`.
- **`.env.sellers`:** `SELLER_ADDRESSES`, `SELLERS_PORT`, `MOCK_PAYMENTS`, `MAINNET_SELLER_ADDRESS`, `MAINNET_SELLERS_PORT`.

### Test and demo
```bash
npm test                      # policy + firewall (incl. multi-process races, auth, anomalies, optimizer, security regressions) + web proxy/session
npm run typecheck
npm run test:contracts        # Foundry
npm run demo:local            # offline, mock settlement, repeatable
# live testnet (firewall :4000, sellers :4200, dashboard :3000 running):
set -a; . ./.env.firewall; set +a
npx tsx scripts/stress-api.ts       # needs stress-agent in FIREWALL_AGENT_TOKENS (+ FIREWALL_SERVICE_TOKEN)
npx tsx scripts/demo-scenarios.ts   # scenarios A–F; needs demo-agent in FIREWALL_AGENT_TOKENS
```

## Safety limits (read this)

What is actually enforced, and where. The payer is a **Circle Agent Wallet** on both networks. Agent Wallets are smart-contract accounts, and nanopayments don't accept their signatures, so the firewall can't hand out a signature. Instead it checks the seller's 402 (payee and amount) against the reservation, then pays with Circle's documented `circle services pay <url> --max-amount <reserved>`. The agent gets only the response (`docs/RESEARCH.md` Q10).

- **Testnet (default): firewall-only enforcement.** Circle spending policies are mainnet-only, so nothing at Circle backs up our rules on testnet. The outer cap is our own job: we top up the wallet's Gateway balance by at most $5 per UTC day.
- **Mainnet (`NETWORK=mainnet`): Circle policy as an outer wall, plus the firewall.** The Agent Wallet carries a Circle policy: $5/day, with only our demo seller allowlisted. Even if our service is compromised, Circle should refuse anything over the cap or to another address (tests in `HANDOFF.md` §15). The vault and registry stay on Arc testnet; they are not redeployed.


| Protection | Enforced by | Trust assumption |
|---|---|---|
| All rules (budgets, limits, allowlist, categories, hours, rate limit, pause) | Firewall service (atomic `BEGIN IMMEDIATE` reservation) | You trust our service and its database |
| Agent can't pay without approval | Only the firewall pays. It holds the Circle CLI session (`~/.circle-cli` of the user running it). The agent holds no credentials and starts with a fresh, empty HOME, so the CLI there has no session (verified). `local-key` fallback: the firewall is the only x402 signer | The firewall host isn't compromised. A same-user process could still read `~/.circle-cli` by path. Then the limit is Circle's policy on mainnet, or the $5/day Gateway cap plus the wallet's idle balance on testnet |
| **Mainnet outer wall** | **Circle Agent Wallet policy:** daily transfer limit + recipient allowlist, set with `circle wallet limit set` (email OTP per change) | Circle's enforcement. Docs say limits cover "outbound transfers and x402 payments"; allowlist coverage of x402 payees is checked by test (c2) in `HANDOFF.md` |
| Agent can't change its own rules, unpause itself, or act as another agent | Every firewall route has an access class (`apps/firewall/src/auth.ts`, `docs/API.md` "Authentication"). Rules, pause/resume, activity and passkey enrollment need `FIREWALL_OWNER_TOKEN`, which only the dashboard's server-side proxy holds (the browser gets an HttpOnly session cookie). Each agent token is bound to one agent id and to that agent's payment requests | The owner token stays on the firewall and dashboard hosts. `FIREWALL_ALLOW_UNAUTHENTICATED_AGENTS=1` (testnet-only migration switch) lets agents skip their token, but never opens owner routes |
| Agent can't see any secret | The agent starts with a clean environment (`scripts/run-agent.sh`, `env -i` + allowlist) and refuses to run if it sees a key (exit 78). Secrets live only in `.env.firewall` | **Environment only.** On one laptop the agent runs as the same OS user and *could* read `.env.firewall` from disk. Real isolation needs a separate OS user or container |
| Payee and amount can't be swapped after approval | Agent Wallet: the firewall checks the seller's 402 `payTo` and amount against the reservation, then pays with `--max-amount` = the reserved amount, once per request. `local-key`: the signer checks the EIP-712 message | Between our check and Circle's payment, a seller could change `payTo`. On mainnet, Circle's recipient allowlist covers this; on testnet nothing does (our sellers only) |
| A failed payment can't be quietly re-settled | If a payment fails after the CLI ran (or after signing), it stays counted ("unconfirmed") until you reconcile it (Activity → "Needs reconciling"); it is never released by time alone. Allowed payments that are never signed or paid are released after `RESERVATION_TTL_MINUTES` (15). Circle refusals are logged as "Circle wallet policy" with Circle's message | None beyond the firewall DB |
| **Testnet outer wall: daily cap on what the payer can spend at all** | The payer's Gateway balance is topped up from the treasury by at most **$5 per UTC day** (`gateway_topups` ledger). `local-key` also sweeps idle buyer-wallet USDC to the treasury | Enforced by *our* service, **not by Circle**. Agent Wallet USDC that sits outside Gateway (e.g. faucet funds) isn't swept: we can't sign for it. Keep the wallet's plain balance small |
| Held money can't be released without you | `ApprovalVault.approve` is `onlyOwner` | **Hackathon shortcut:** the owner key is held by the service and used only after a WebAuthn check. A compromised service could release funds. The fix is a passkey-native owner wallet (Circle Modular Wallets), not yet done |
| Held payment really is escrowed | `vaultHold` preflights the treasury allowance/balance; if the hold fails, the UI says "Not recorded on Arc" and cancel says "never left your treasury" | Treasury allowance must be topped up (`/health` → `vault.low`) |
| Cancel by text | Twilio webhook signature + `deny()` callable by the service | Twilio and SIM security. Cancelling only ever refunds |
| Held money comes back if you do nothing | `refundExpired` is callable by anyone after expiry | Arc liveness |
| Rules weren't changed after the fact | Policy hash committed to `PolicyRegistry` | `commitPolicy` is owner-only. For the demo, the service key is deployed as owner |

**What we do not claim.**

- **Circle Agent Wallet caps and allowlists are not part of the testnet demo.** The demo does pay from a Circle Agent Wallet, but policies are mainnet-only: "Spending policies require a mainnet agent wallet. Testnet is not supported." (`docs/RESEARCH.md`, Q9 and Q10). Our testnet outer wall is the $5/day Gateway top-up cap, which our own service enforces. Mainnet adds Circle's.
- **Worst case if the agent is fully hijacked:** it can only request payments. It can't spend beyond your rules or pay anyone the firewall didn't approve.
- **Worst case if the payer credential leaks:**
  - Testnet: that day's Gateway balance (≤ $5) plus the Agent Wallet's plain balance (`local-key`: plus a $0.50 gas reserve).
  - Mainnet: whatever Circle's policy allows ($5/day, allowlisted payees only).
- **Worst case if the firewall host is compromised:** it holds the treasury and owner keys too, so it can spend the treasury and release held funds. Keep the treasury small. This is the main remaining trust assumption.
- **The sellers are ours,** run for the demo. Arc testnet has no comparable real x402 sellers (`docs/RESEARCH.md`, Q6).
- **The "hijacked agent" in the demo is scripted to obey the injection.** That's the point: the firewall holds even when the agent doesn't.
- **Injection flags are heuristics,** shown only to the human. They never cause a payment to be allowed.
- **The optimizer's providers are our two demo sellers.** No external comparable x402 providers are integrated. Savings are the price difference between them, and are "realized" only for a settled payment that followed the recommendation.
- **Mainnet is untested.** The code path exists, but the Circle policy tests (cap and allowlist enforced by Circle) haven't run because the mainnet wallet isn't funded yet.
- **"Settled" means the seller accepted and delivered after Circle took the payment.** Gateway settles with sellers in batches, and the Agent Wallet CLI returns no transaction reference, so the dashboard doesn't claim an onchain confirmation for these.
- **Passkey approval** was verified live on 2026-11-16. The current database was recreated on 2026-11-17, so the owner must enroll a passkey again before approving holds.
- **Optimizer requests aren't rate-limited.** An agent can request recommendations repeatedly. Each one makes unpaid 402 calls to our sellers and stores a row. Fine for a demo; add a limit before real use.
