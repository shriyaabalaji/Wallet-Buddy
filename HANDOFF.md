# HANDOFF: Agent Firewall (UBC Hackathon 2026)

> Read this whole file before writing code. It is the source of truth for scope, architecture and build order.
> **Start with §0 (build status).** It records what is built, what changed from the original plan and why, and what's next. Keep §0 updated as you work.

---

## 0. Build status (updated 2026-11-16)

### Verify the build
```bash
npm install
npm test                 # 17 policy + 14 firewall tests (incl. multi-process race + signer)
npm run test:contracts   # 17 forge tests
npm run demo:local       # full demo (normal / race / attack) with throwaway keys and mock seller settlement
```
For how to run, the architecture and the honest safety limits, see `README.md`. API contract: `docs/API.md`. Verified Circle/Arc/x402 facts with sources: `docs/RESEARCH.md`. **Read RESEARCH.md before touching any Circle integration.**

### Done
| Area | Where | Status |
|---|---|---|
| Policy engine, all 9 rule kinds, canonical hash, 6/18-decimal normalization | `packages/policy` | ✅ tested |
| Atomic evaluate+reserve (`BEGIN IMMEDIATE`), idempotent requestId, deny-by-default with no policy | `apps/firewall/src/engine.ts` | ✅ race tested across 6 OS processes |
| English→rules compiler (Claude `claude-opus-5-5` structured output; offline regex fallback), ambiguity flags, dry run, confirm-gated save | `apps/firewall/src/compiler.ts`, `dryrun.ts` | ✅ (LLM path untested without key) |
| **Firewall is the only x402 signer** (see "Plan changes") | `apps/firewall/src/signer.ts` | ✅ tested with the real `BatchEvmScheme` |
| Holds: SMS (Twilio REST + signature check), NO cancels, YES refused, PAUSE, 15-min expiry sweeper | `approvals.ts`, `sms.ts`, `server.ts` | ✅ smoke-tested in SMS dry-run mode |
| Owner passkey (WebAuthn) enrollment + approve | `approvals.ts`, `apps/web/src/passkey.tsx`, `/a/[token]` | ✅ **verified 2026-11-16 with Touch ID in Chrome on macOS (localhost)**: $1.50 hold to sportsfeed → passkey approve → vault released to seller ([tx](https://explorer.testnet.arc.io/tx/0xc0ca1da8c9949055cf73a0be06228e1fab6f4626bcd2530970d789a5fe434018)). Phone still needs an HTTPS tunnel + matching `WEBAUTHN_RP_ID` |
| Arc adapter: commitPolicy, batched logDecisions, vault hold/deny/approve/refundExpired | `apps/firewall/src/arc.ts` | ✅ live on testnet except `approve` (needs passkey) and `refundExpired` |
| Contracts `PolicyRegistry`, `ApprovalVault` + deploy script | `contracts/` | ✅ tested + **deployed to Arc testnet** |
| Web: Home, Rules, Activity, approve page | `apps/web` | ✅ clicked through against the live testnet backend (Home cards update live, Review → approve page → Cancel refunds onchain). Passkey approve still untested |
| Demo sellers (Circle Gateway middleware or `MOCK_PAYMENTS=1`), one compromised endpoint | `apps/sellers` | ✅ mock **and live Gateway** |
| Demo agent (no keys; normal / race / attack phases) | `apps/agent` | ✅ mock mode |
| README with Safety limits | `README.md` | ✅ |

### Plan changes (and why)
1. **Circle Agent Wallet caps/allowlists are mainnet-only** (RESEARCH Q2), so the §4 "outer wall" cannot be demoed on testnet. Instead, **the firewall holds the buyer key and the agent has none.** The agent asks `/v1/payments/:id/sign`, and the firewall signs the Gateway `TransferWithAuthorization` only if payee, amount, chain and verifying contract match a reservation it already allowed (one signature per request). Do NOT re-add claims that "Circle's allowlist rejects it" to the demo or README.
2. **Injection amount is $3, not $50.** $50 exceeds the $10 task budget (block beats hold) and the $5 daily cap. $3 is over the $1 threshold and to an unknown address, so it is **held**, which is what the demo needs.
3. **Race runs on its own agent (`race-agent`) with a $1.00 budget**, so it doesn't exhaust the main task budget before the attack scene.
4. **Allowlist violations default to HOLD, not block** (the SMS copy in §8 is for unknown addresses). Override per rule with `onViolation: "block"`. Budgets and limits block. Block beats hold.
5. **Owner approval:** WebAuthn gates a service-held owner key that calls `ApprovalVault.approve`. This is a disclosed hackathon shortcut; Circle Modular Wallets (passkey-native) is the proper fix (RESEARCH Q8).
6. Vault uses `hold()` with `transferFrom` from a treasury, called by the service (RESEARCH "Implications" §4).
7. SQLite via built-in `node:sqlite`, not better-sqlite3 (no native build).
8. `@circle-fin/x402-batching` pinned to **2.0.4** (matches `circlefin/arc-nanopayments`; npm latest is 4.x with a different shape).

### Live on Arc testnet (verified 2026-11-16)
End to end against real Circle Gateway + our deployed contracts:
- ✅ **Real x402 nanopayments**: the agent (no key) buys from our sellers; the firewall signs; Circle Gateway verifies and settles.
- ✅ Policy hash committed to `PolicyRegistry` ([tx](https://explorer.testnet.arc.io/tx/0xa72414dfe452e11c01a3468abc168b79c7a6968cfcbe5d9448069fac078c0ab0)).
- ✅ Decisions batch-logged to `PolicyRegistry` every 10s.
- ✅ Race on live: one $0.80 allowed, one blocked.
- ✅ Re-verified 2026-11-16 23:23: hold [tx](https://explorer.testnet.arc.io/tx/0x78edc769888bbe0e43463dfdb7dd23bc641825df8e507de34131f1ad05bb3f3d) → cancel → refund [tx](https://explorer.testnet.arc.io/tx/0x7ec12416c5f71327d06527aae618cb4619f9e02a07b47cad498743e2ef25c64a), vault back to 0.
- ✅ Injection: $3 held in `ApprovalVault` ([hold tx](https://explorer.testnet.arc.io/tx/0x31e87d5828f3dd19a9184a33524adf6b50ab168a00b26628f67884c910b186c4)), cancelled, refunded ([refund tx](https://explorer.testnet.arc.io/tx/0x63625b8688439e0300c4465d87e5b0c0195571a92c81a8531b32ff83b8ee3e69)); vault balance 3 → 0.

| Contract / wallet | Address |
|---|---|
| PolicyRegistry | `0xaD5f1662D6aA4c5EBEa26faaD4b68f3F3dA1d6D7` |
| ApprovalVault | `0x8949af64EB0ecafD2165480830Fe13e73df18DEF` |
| Service (deployer, registry owner, vault service, treasury) | `0x61D04924230Effe51bD57879638ECe5d99Eebcc4` |
| Vault owner (releases held funds after passkey) | `0x6e6C13010e65f070876Ec1C5aa59fB07B147b4e7` |
| Buyer (firewall-held; Gateway balance ~2 USDC) | `0xa761a0FbC633f6491E7D69c03A8b311BBF91084E` |

**Private keys are only in the original dev machine's `.env` (gitignored).** Teammates: ask for the `.env` over a private channel, or deploy your own set (README "To go live"). Faucet: faucet.circle.com → Arc Testnet → 20 USDC per address every 2h, no login.

**Gotcha found live:** Circle Gateway rejects authorizations valid for under ~7 days (`authorization_validity_too_short`), but the 2.0.4 SDK's sellers advertise 4 days. The agent signs for 8 days (`apps/agent/src/index.ts`), and the firewall signer allows up to 9. Circle's docs disagree on the minimum (3 vs. 7 days). Upgrading to SDK 4.x may remove the need for this workaround.

Operator commands: `npm run balance -w @agent-firewall/firewall`, `npm run deposit -w @agent-firewall/firewall -- 2`.

### Next up (in order)
1. ~~Testnet bring-up~~ done (above).
2. ~~Click through the web app~~ done. Remaining UI polish is optional.
3. Twilio: verify team phones, set `FIREWALL_PUBLIC_URL` (e.g. via a tunnel) as the inbound webhook, and test a real NO reply.
4. ~~Passkey approve~~ done on Mac (Touch ID). Optional: phone via HTTPS tunnel; set `APP_BASE_URL` + `WEBAUTHN_RP_ID` to the tunnel host and re-register the passkey there.
5. Record a backup video of `npm run demo:local` + web UI.

### Known gaps / gotchas
- **UI design (current, user-approved direction):** light fintech "bento" dashboard modeled on a reference the user picked, in **real Circle + Arc brand colors** pulled from circle.com / arc.network CSS: canvas Circle Licorice #F1F0F5, Arc Protocol Navy #1B3158 (hero card, active nav, primary buttons), Arc Validator Blue #2F578C, Arc Sky Sync #ACC6E9, Circle USDC Stable Blue #2775CA / #0B53BF = allowed, Arc Blockstream Gold #E9A13F (fills) / #A15C07 (text) = attention (color-blind safe, no red/green). Floating white left sidebar with icons, 24px rounded cards, pill buttons, Outfit headings + money (faded cents), Inter body, JetBrains Mono for hashes/times. Overview: daily-allowance navy card, task budget, payments-by-hour stacked chart (paid vs stopped, hatched), "kept from leaving", payment history, rules. Rejected earlier: dark dashboard, uizze playful, UBC marketing. Don't restyle without asking.
- **Vault allowance runs out (found 2026-11-16 live test):** `ApprovalVault.hold` pulls USDC from the treasury with `transferFrom`, so the treasury must `approve` the vault. The setup allowance was used up by earlier holds, and the next hold reverted with "ERC20: transfer amount exceeds allowance". **The app still showed "Held" and later "Cancelled/Refunded" with no onchain tx** (no "verify on Arc" link). Fixed for now by approving 20 USDC (tx 0x550df44a…7d00). Check before demos: `cast call $USDC_ADDRESS 'allowance(address,address)(uint256)' $TREASURY $VAULT_ADDRESS`. **Fixed:** `vaultHold` checks allowance + treasury balance first and fails with a readable reason, saved as `holds.hold_error`; cancel/expiry skip the vault when nothing was escrowed ("never left your treasury"); passkey approve is refused for un-escrowed holds; `/health` reports `vault.allowanceUsdc`, `treasuryUsdc` and `low` (< 5 USDC). Note each hold consumes allowance permanently, even when refunded, so top it up before demos.
- The Rules page quick test uses the agent's *current* spend, so after the attack scene the $3 sample shows Blocked (daily budget). Record the Rules scene first.
- On a fresh DB, the agent is blocked until rules are saved (deny by default). Save rules on `/rules` first.
- If `vaultApprove` fails after a passkey OK, the DB says "approved" but funds stay in the vault until `refundExpired`. Surface this in the UI if it shows up in testing.
- Deploy script: the deployer (service key) owns `PolicyRegistry`; `OWNER_ADDRESS` owns `ApprovalVault`.
- Disk on the original dev machine is nearly full; `apps/web/.next` is large, so delete it after builds.

---
> **Never guess Circle / Arc / x402 API signatures.** Check the official docs and the starter repo (`circlefin/arc-nanopayments`) first. If something is unclear, stop and leave a `TODO(verify)` note instead of inventing an API.

---

## 1. Context

- **Event:** University Blockchain Conference (UBC) 2026 Hackathon. Hacking is online; finals are Nov 21 at UT Austin.
- **Deadline:** Devpost submission **Fri Nov 20, 12:00 PM CST**. Treat **Thu Nov 19, 11:59 PM** as the real deadline.
- **Prizes we are targeting:**
  - **Main track: Agentic Payments & AI.** Brief: "Give AI agents wallets, budgets, and guardrails to pay for APIs, data, and compute."
  - **Chain award: Best use of Arc**, judged by Circle. Testnet is fine.
- **Submission requirements** (confirm against the UBC guide): working prototype, public GitHub repo, README with architecture and safety limits, 2–3 minute demo video.

## 2. One-line pitch

**Circle's Agent Wallets give agents caps and allowlists. We add what's missing: conditional rules written in plain English, payments held on Arc until a human approves them, and an onchain audit trail, so an agent can't overspend even if it gets hijacked.**

Positioning: we **extend** Circle Agent Wallets. We are not a competing "financial OS." Don't describe the product as an OS anywhere in the UI or README.

## 3. Scope

### MVP (must work end to end by **Wed Nov 18, 12:00 PM**)
1. Circle Agent Wallet on **Arc testnet**, funded with testnet USDC from faucet.circle.com.
2. A demo agent that pays an **x402** endpoint with **Circle Nanopayments** (start from `circlefin/arc-nanopayments`).
3. **Policy engine** (the firewall), with rule types:
   - per-transaction limit
   - task budget (e.g. $10 total for a task)
   - daily, weekly and monthly budgets
   - purchase categories (e.g. `data`, `inference`, `compute`)
   - recipient/service allowlist
   - time windows (e.g. only spend 9am–9pm, or only on given days)
   - frequency limit (e.g. more than 20 payments a minute → auto-pause)
   - approval threshold (e.g. above $1 → hold for human approval)
   - emergency pause
4. **Atomic budget reservation.** Concurrent requests must not overspend (see §7.4).
5. **English → rules compiler** using an LLM with structured output. Show the compiled rules, then run a **dry run** on sample payments, then require the user to confirm. Never apply compiled rules silently.
6. **Arc contracts:** `PolicyRegistry` (policy hash + decision events) and `ApprovalVault` (holds payments that need approval). See §6.
7. **Text-message approvals** via Twilio (see §8).
8. **Website:** Home, Rules, Activity log, and the approve-link page (see §9).
9. **The injection-attack demo scenario** (see §11).

### Stretch features (add one at a time, in this order)
Only start the next stretch feature when the MVP demo path works end to end **and a backup demo video is recorded**.
1. Multi-agent: a shared org budget plus per-agent allowances. Budget transfers between agents come last.
2. Payment optimizer: route to the cheapest comparable provider. **Only if 2 or more real, comparable x402 providers exist** (check Circle's agent service marketplace). No mock providers presented as real.
   - Team note: there's an idea to use the **Grok Bot** for this. The Grok Bot bounty requires that it "does real work." Only pursue this if Grok genuinely does the comparison; otherwise skip it.
3. Simple anomaly alerts (a spike in frequency or amount compared with the agent's recent average).
4. A small TypeScript SDK (`@agent-firewall/client`).

### Out of scope (this week)
Cross-chain, fiat on-ramps, ML fraud models, procurement policies, business model work. Use SQLite, not PostgreSQL.

## 4. Architecture

```
            ┌──────────────┐  structured PaymentRequest   ┌─────────────────────────┐
            │  Demo agent  │ ───────────────────────────▶ │  Firewall service (TS)  │
            │  (LLM + x402)│ ◀─── allow / block / hold ── │  policy engine + SQLite │
            └──────────────┘                              └───────────┬─────────────┘
                   │ allowed small payments                           │ hold > $1, log decisions
                   ▼                                                  ▼
   ┌──────────────────────────────┐                     ┌──────────────────────────┐
   │ Circle Agent Wallet (Arc)    │ ── only allowlisted ▶│ ApprovalVault (Arc)      │
   │ native policy: daily cap $5, │    recipients incl. │ hold → approve/deny →    │
   │ allowlist = sellers + vault  │    the vault        │ timeout refund           │
   └──────────────┬───────────────┘                     └──────────────────────────┘
                  │ x402 nanopayments (Gateway batches, settles on Arc)
                  ▼
           x402 data sellers                     PolicyRegistry (Arc): policy hash + decision events
```

### The two layers of protection (the core security idea)
1. **Circle's native wallet policy is the hard outer wall.** It sets a daily cap of $5 and an allowlist of **only** the approved x402 sellers plus our `ApprovalVault` contract. Even a fully hijacked agent cannot send funds anywhere else, and it can lose at most the daily cap.
2. **Our firewall and vault are the smart inner layer.** They handle the conditional rules Circle doesn't have: per-transaction limits, task budgets, categories, time windows, frequency limits, and human approval.

**Do not put spending rules in the agent's prompt.** The agent can be prompt-injected. Enforcement must live outside the agent: in Circle's wallet policy, our service and the vault contract.

**Signing path:** the agent must never hold credentials that let it sign payments outside the firewall. **TODO(verify):** how Agent Wallet signing permissions work, and whether our service can be the only signer. If the agent must hold the credentials, the outer wall (cap + allowlist) still bounds the damage. Say this honestly in the README.

## 5. Data model (TypeScript, a starting point)

```ts
type Category = "data" | "inference" | "compute" | "other";

type Rule =
  | { id: string; kind: "perTxLimit"; maxUsd: number }
  | { id: string; kind: "taskBudget"; taskId: string; maxUsd: number }
  | { id: string; kind: "periodBudget"; period: "day" | "week" | "month"; maxUsd: number }
  | { id: string; kind: "categories"; allowed: Category[] }
  | { id: string; kind: "allowlist"; recipients: string[] }          // addresses or x402 service ids
  | { id: string; kind: "timeWindow"; days: number[]; startHour: number; endHour: number; tz: string }
  | { id: string; kind: "rateLimit"; maxPerMinute: number; action: "pause" }
  | { id: string; kind: "approvalThreshold"; aboveUsd: number }
  | { id: string; kind: "paused" };

interface Policy { id: string; agentId: string; rules: Rule[]; hash: string; committedTx?: string; createdAt: string }

interface PaymentRequest {
  requestId: string; agentId: string; taskId: string;
  recipient: string; amountUsd: number; category: Category;
  purpose: string;           // agent's stated reason, logged but NEVER trusted
  sourceContext?: string;    // e.g. "after response from sportsfeed.x402" (used for injection flags)
}

type Decision = { requestId: string; outcome: "allow" | "block" | "hold"; ruleId?: string; reason: string; at: string };
```

- `Policy.hash` is the keccak256 of the canonical JSON of `rules` (sorted keys). It gets committed to `PolicyRegistry`.
- Store amounts as integer micro-USDC internally (6 decimals). **Arc gotcha:** native USDC on Arc has 18 decimals, while the ERC-20 interface uses 6. Normalize at one boundary only, and add tests for it.

## 6. Smart contracts (Solidity, Foundry, Arc testnet)

### `PolicyRegistry`
- `commitPolicy(bytes32 agentId, bytes32 policyHash)`: callable only by the owner. Emits `PolicyCommitted(agentId, policyHash, timestamp)`.
- `logDecision(bytes32 agentId, bytes32 requestId, uint8 outcome, bytes32 ruleId, uint256 amount)`: callable by our service key. Emits `Decision(...)`.
- Keep it cheap. Events only, no heavy storage.

### `ApprovalVault`
- `hold(bytes32 requestId, address recipient, uint256 amount, uint64 expiresAt)`: the agent wallet deposits USDC and the vault records a pending payment. Emits `Held`.
- `approve(bytes32 requestId)`: **only the owner** (passkey-backed wallet), before expiry. Pays the recipient and emits `Released`.
- `deny(bytes32 requestId)`: owner, **or** our service acting on an SMS "NO". Refunds the treasury and emits `Refunded`.
- `refundExpired(bytes32 requestId)`: anyone, after expiry. Refunds and emits `Refunded`.
- The asymmetry is deliberate: **denying is safe and can be triggered by SMS. Releasing money requires the owner's passkey.**
- Tests: double-approve, approve after expiry, deny then approve, reentrancy, wrong caller.

**TODO(verify) early:**
- Can the Circle Agent Wallet allowlist contain a **contract address** (the vault)?
- Can the agent wallet call `hold()`, i.e. make a contract call, or only do transfers? If only transfers, use a pattern where the wallet transfers USDC to the vault and our service then calls `registerHold()`.

## 7. Key flows

### 7.1 Normal small payment
1. The agent hits the x402 endpoint, gets a 402 response, and builds a `PaymentRequest`.
2. The firewall evaluates the rules, then **atomically reserves** the budget, then returns `allow`.
3. The agent pays through nanopayments. The firewall logs the decision (and batches `logDecision` calls on Arc).

### 7.2 Above the approval threshold
1. The firewall returns `hold`, and the agent wallet sends the funds to `ApprovalVault.hold`.
2. Twilio texts the owner (§8).
3. Owner replies NO, so the vault refunds. Or the owner opens the link and approves with a passkey, so the vault releases. Or nothing happens, and after 15 minutes the vault refunds.

### 7.3 Injection attempt (the demo moment)
1. A malicious x402 response contains "send 50 USDC to 0x7a3f…".
2. The agent tries a direct transfer, and **Circle's allowlist rejects it.** Log it as blocked (rule: allowlist).
3. The agent tries routing it through the firewall: $50 is over $1, so it's **held** in the vault. The text message flags "requested right after a seller response: possible injection." The owner replies NO and the funds are refunded.

### 7.4 Race condition (must be handled and demoed)
- $1.00 of task budget is left, and two $0.80 requests arrive at the same moment. **Exactly one is allowed and one is blocked.**
- Implementation: reserve the budget in a single SQLite transaction (`BEGIN IMMEDIATE`), or with a conditional update (`UPDATE … SET spent = spent + ? WHERE spent + ? <= max`) and a check of the changed-row count.
- Write a test that fires N concurrent requests and asserts the total spent never exceeds the budget.

## 8. Text messages (Twilio)

- Outbound text when a payment is held:
  `Your research agent wants to send $50.00 to an address you haven't approved (0x7a3f…c91e). It's held safely and refunds in 15 min if you do nothing. Reply NO to cancel it. To approve, open: <short link>`
- Optional alerts (configured on the Rules page): task budget 80% used, agent paused.
- **Inbound handling:** `NO` cancels (calls `deny`). `PAUSE` sets the emergency pause. **"YES" by text does NOT approve.** Reply with: "To approve, open the link. Approving needs your passkey."
- Validate Twilio webhook signatures. The approval links must be single-use and expiring, with an unguessable token.
- A Twilio trial account can only text verified numbers. Verify the team's phones early.

## 9. Frontend (Next.js)

Design reference (Claude design canvas): https://claude.ai/artifact/NEjCKhV2ypdvLfoHiz63kN

The design goal: **super user-friendly and simplified, plain language, no jargon in the main UI.** Crypto details (hashes, tx links) only appear behind small "verify on Arc" links.

1. **Home:** agent status plus a Pause button. Three cards: "Spent on this task" ($9.80 of $10), "Can still spend today" ($1.34 of $5), "Waiting for you" (the held payment, with a Review button). A "What your agent did" feed in plain sentences ("Bought an injury report, $0.02"). Your rules as sentences, plus "Rules locked on Arc · verify".
2. **Rules:** step 1 "Tell us" (a free-text box), step 2 "Here's what we understood" (each rule as a sentence + value + what enforces it, with an edit button; flag ambiguous phrases like "goes crazy"), step 3 "Quick test" (4 sample payments → Pays / Texts you first / Blocked), then "Text me when" (checkboxes + phone number), then **Save rules** (commits the hash to Arc, about 1¢).
3. **Activity log:** a table with time, decision, amount, recipient, rule, detail and Arc tx link. Filters for All and Blocked only. Two callouts explain the race condition and the injection attempt.
4. **Approve link page** (mobile, opened from the text): amount, recipient, "Why we stopped it", refund countdown, **Cancel payment** (primary) and **Approve with passkey** (secondary, requires WebAuthn). Note: "Approving always needs your passkey."

- Colors: **blue `#1F4FD1` = allowed, orange `#B54708` = blocked or needs attention** (not green and red, for color-blind users). Background `#F6F7F9`, text `#14171F`, muted `#5B6270`.
- Fonts: Inter (body), Space Grotesk (headings), JetBrains Mono (amounts, addresses).
- Tap targets ≥ 44px. Real `<button>`, `<a>` and `<label>` elements.

## 10. Stack and repo layout

- TypeScript / Node, Next.js (App Router), viem, Foundry, SQLite (better-sqlite3 or Drizzle), Twilio, an LLM API for the rules compiler and the demo agent.

```
/apps/web            Next.js site (Home, Rules, Activity, /a/[token] approve page)
/apps/firewall       policy engine service + Twilio webhooks + Arc logging
/apps/agent          demo agent (x402 buyer, based on circlefin/arc-nanopayments)
/apps/sellers        demo x402 sellers (honest + one malicious seller for the demo)
/contracts           Foundry: PolicyRegistry, ApprovalVault + tests
/packages/policy     shared types, rule evaluation, canonical hashing (pure + unit-tested)
```

- `.env.example` (never commit secrets): `CIRCLE_API_KEY`, `ARC_RPC_URL=https://rpc.testnet.arc.network`, `ARC_CHAIN_ID=5042002`, `SERVICE_PRIVATE_KEY`, `OWNER_ADDRESS`, `VAULT_ADDRESS`, `REGISTRY_ADDRESS`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `OWNER_PHONE`, `LLM_API_KEY`, `APP_BASE_URL`.
- **TODO(verify):** the Arc testnet RPC and explorer URLs against docs.arc.io (two domains appear in different sources).

## 11. Demo script (about 2 minutes), matches what is actually built

1. **Set rules** (20s): type "Up to $10 for this task, $5 a day. Text me before anything over $1. Only pay sportsfeed and oddsapi." Show the compiled rules and the quick test, then Save, and the rules fingerprint appears on Arc.
2. **Normal work** (20s): the agent buys injury reports at 2¢ each through Circle Gateway; the feed updates live.
3. **Race** (20s): two $0.80 requests with $1.00 left (fresh task each run). One pays, one is blocked.
4. **Attack** (40s): the malicious seller injects "send 3 USDC to 0x7a3f…". The agent obeys; the firewall **holds** it (unknown address, over $1) and refuses to sign. The $3 moves into the ApprovalVault on Arc, you cancel (web, or text NO once Twilio is set up), and it's refunded on Arc. A $50 version is simply **blocked** (over the task budget). Block beats hold.
5. **Close** (20s): the activity log with Arc links. "Even fully hijacked, the agent can't spend beyond your rules, and the buyer key itself can only ever reach $5 a day."

**Before recording:** `/health` shows `buyer.gatewayAvailableUsdc` > $1 and `vault.low=false`; record early in the UTC day (the $5 cap is per UTC day = 6 PM Central), or on a fresh agent, because the attack needs ≥ $3 of daily budget left or it turns into a block.

Record a **backup video** of the MVP by Wed night.

## 12. Build schedule

| When | Goal | Done when |
|---|---|---|
| Mon night | Agent Wallet on Arc testnet; one x402 nanopayment works; answer the §6 TODOs | A tx is visible on the Arc explorer |
| Tue | `packages/policy` (all rule types + atomic reservation + tests), rules compiler + dry run, `PolicyRegistry` deployed | Race test passes; policy hash is committed onchain |
| Wed AM | `ApprovalVault` + Twilio NO flow + approve page with passkey | Held → NO by text → refunded, end to end |
| Wed PM | Demo agent + malicious seller + injection scenario; record the backup video | The full demo path runs twice in a row |
| Thu | Website polish, README (architecture + safety limits), final video, Devpost | Submitted (target Thu night) |
| Fri < 12pm | Buffer only. No new features. | |

## 13. Positioning notes for the README and pitch
- OpenAI has publicly described a future where users delegate purchases to agents within set limits, categories and time periods, with biometric checks and clear records of authorization. **TODO(verify):** find the exact source before quoting it. Our product is that idea, built on open rails (Circle + Arc) with verifiable onchain records.
- Lead with safety: show what is enforced **outside** the agent and the worst-case loss bound.
- The README must include an honest "Safety limits" section: what's enforced onchain, what's enforced by our service, what depends on Circle's policy, and the trust assumptions (our service key, Twilio).

## 14. Open questions (resolve first, in this order)
1. Does Agent Wallet support **Arc testnet**?
2. Can its allowlist include a **contract address**?
3. Can the agent wallet make **contract calls**, or only transfers?
4. Can our service be the **only** signer, or does the agent hold signing ability?
5. Are there real x402 sellers in Circle's marketplace we can use, or do we run our own (disclosed as demo sellers)?
6. The passkey approval path: use Circle Wallets (user-controlled, passkey) for the owner, or WebAuthn plus an owner key held by our service? Prefer Circle's option if feasible.

## 15. Circle Agent Wallets (branch `circle-agent-wallets`): testnet default, mainnet behind `NETWORK=mainnet`

**Testnet (default), verified 2026-11-17.** Payer: Agent Wallet `0xbc98fa7d89306239f72d4946aedd478fddf1693d` (ARC-TESTNET; `CIRCLE_AGENT_WALLET_ADDRESS` in `.env.firewall`). Funded from the Circle faucet, with $5 deposited to Gateway.

| Test | Result |
|---|---|
| Happy path | Live nanopayments paid by the Agent Wallet via the firewall; Gateway balance 5.00 → 4.98 after the first |
| Race (stress-api, 20 × $0.80 vs $1) | 1 allowed / 19 blocked; live race paid $0.80 once, blocked the other |
| Idempotency, release on unsigned failure | Pass |
| Payer refuses blocked/held requests | Pass (`/pay` → 403) |
| Injection | $3 to a raw address HELD on Arc (hold tx `0xe168934e…7b5d`); `/pay` refused |
| Isolation | Agent exits 78 if it sees a secret. Under the agent's empty HOME, the CLI has no session (it even asks for terms again) |
| Retries / failure after the CLI ran | Counted as "unconfirmed"; Circle refusals logged as "Circle wallet policy" (verified with a stand-in CLI) |

Fallback: `PAYMENT_MODE=local-key` (old firewall-held buyer key).

Gotcha: an Agent Wallet's Gateway balance belongs to its **backing EOA** (`circle gateway balance --output json` → `backingEOA`; ours is `0x74f1e850fc6c03546e59e6aef7db41ff9f0e318b`), not the wallet address. The top-up job deposits for `CIRCLE_GATEWAY_DEPOSITOR` (verified: treasury depositFor $0.50 → CLI balance 4.06 → 4.56).

Gotcha: the $5/day top-up ledger is shared across payers. On a day the old buyer was already topped up, fund the Agent Wallet by hand (`circle gateway deposit`).

### Mainnet

Why the design is a *payer*, not a *signer*: Agent Wallets are smart-contract accounts, and Gateway nanopayments don't accept ERC-1271 signatures. The only documented way to pay x402 from an Agent Wallet is `circle services pay`. See `docs/RESEARCH.md` Q10.

**Setup (owner does every OTP step in their own terminal; never give an agent the inbox):**
```bash
npm install -g @circle-fin/cli@1.4.0
circle wallet login you@example.com                # mainnet session (OTP); accept terms when asked
circle wallet list --type agent                     # copy the ARC address → W
W=0x...                                             # your Agent Wallet on Arc mainnet
circle wallet fund --address $W --chain ARC --amount 10 --method crypto   # or send 10 USDC on Arc mainnet to $W
circle wallet balance --address $W --chain ARC
circle gateway deposit --amount 9 --address $W --chain ARC --method direct   # BEFORE the allowlist
circle gateway balance --address $W --chain ARC
circle wallet limit set --address $W --chain ARC --policy-type stablecoin --daily 5             # OTP
circle wallet limit set --address $W --chain ARC --policy-type stablecoin \
  --rule-type recipient-allowlist --targets "[0x61D04924230Effe51bD57879638ECe5d99Eebcc4]"     # OTP
circle wallet limit --address $W --chain ARC        # verify both rules
```
Then put `W` in `.env.firewall.mainnet` as `CIRCLE_AGENT_WALLET_ADDRESS`.

**Or from the dashboard (2026-11-19):** Settings → Wallet runs the same login non-interactively on the firewall host (`circle wallet login <email> --init`, then `--request <id> --otp <code>` with the code the owner types), finds `W` and its backing EOA, and stores them in `owner_settings` (`apps/firewall/src/wallet.ts`, `circle-connect.ts`). That overrides `CIRCLE_AGENT_WALLET_ADDRESS`/`CIRCLE_GATEWAY_DEPOSITOR` until the owner disconnects. Settings → Add money funds the Gateway account from MetaMask (`depositFor`).

Gotcha: `.env.firewall.mainnet` only overrides `.env.firewall`. If `.env.firewall` is a local demo setup (`PAYMENT_MODE=local-key`, `MOCK_PAYMENTS=1`), the mainnet file must set `PAYMENT_MODE=circle-agent-wallet` and `MOCK_PAYMENTS=0` (the example now does), or the firewall refuses to start / labels real payments "simulated".

**Run:**
- Mainnet seller: `NETWORK=mainnet npm run mainnet -w @agent-firewall/sellers` (port 4300).
- Mainnet firewall: `NETWORK=mainnet npm start -w @agent-firewall/firewall` (port 4100, own DB; refuses `local-key`).
- Agent: `FIREWALL_URL=http://localhost:4100 SELLERS_URL=http://localhost:4300 bash scripts/run-agent.sh normal 1`.

The demo seller's payee is the treasury address, so test payments are recoverable.

**Tests:**
| Test | How |
|---|---|
| (a) $0.02 succeeds | Agent `normal 1` against the mainnet stack. **Passed 2026-11-19:** Gateway balance 1.00 → 0.98 USDC, payee 0.02 `pendingBatch` (Circle Gateway API), activity `settled` ("Seller accepted, no transaction reference"); seller's 402 was `eip155:5042`, `GatewayWalletBatched`, amount 20000 |
| (b) Firewall allows $6, Circle refuses | Set agent rules with no approval threshold and a task budget ≥ $6, then buy `/sportsfeed/bulk`. Expect activity "Blocked $6.00 … Circle wallet policy" |
| (c) Transfer to a non-allowlisted address is refused by Circle | `circle wallet transfer 0x6e6C13010e65f070876Ec1C5aa59fB07B147b4e7 --amount 0.01 --token 0x3600000000000000000000000000000000000000 --address $W --chain ARC` (that is the owner address; we hold its key, so it's recoverable if Circle lets it through) |
| (c2) x402 to a non-allowlisted payee | Same as (a), with the mainnet seller's `MAINNET_SELLER_ADDRESS` set to the owner address and the firewall's `SELLER_ADDRESSES` set to match |
| (d) Testnet unchanged | `npx tsx scripts/stress-api.ts` against port 4000, unit tests, and a live `run-agent.sh all 3` |

Unknowns, settled only by running the tests:
- Circle's refusal wording. Anything matching /polic|limit|allowlist|exceed|…/ is logged as "Circle wallet policy", with the raw CLI message.
- Whether the recipient allowlist matches an x402 `payTo`.
- Whether the Gateway deposit counts against the daily limit.
