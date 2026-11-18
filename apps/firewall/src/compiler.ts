// English → rules. The LLM only PROPOSES rules; output is validated, shown to the user,
// dry-run, and saved only on explicit confirmation. Never applied silently.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { usdToMicro, validateRules, CATEGORIES, type Rule } from "@agent-firewall/policy";
import { config } from "./config";

export interface Ambiguity {
  phrase: string;
  question: string;
}
export interface CompileResult {
  rules: Rule[];
  ambiguities: Ambiguity[];
  model: string;
  errors: string[];
}

const MODEL = "claude-opus-5-5";

const DraftRule = z.object({
  kind: z.enum(["perTxLimit", "taskBudget", "periodBudget", "categories", "allowlist", "timeWindow", "rateLimit", "approvalThreshold", "paused", "anomalyGuard"]),
  amountUsd: z.number().nullable().describe("Dollar amount for limits, budgets and approval thresholds; null otherwise"),
  period: z.enum(["day", "week", "month"]).nullable(),
  categories: z.array(z.enum(CATEGORIES)).nullable(),
  recipients: z.array(z.string()).nullable().describe("Service ids or 0x addresses exactly as the user wrote them, lowercased"),
  days: z.array(z.number().int()).nullable().describe("0=Sun..6=Sat; empty means every day"),
  startHour: z.number().int().nullable(),
  endHour: z.number().int().nullable().describe("Exclusive, 0-24"),
  tz: z.string().nullable().describe("IANA timezone"),
  maxPerMinute: z.number().int().nullable(),
  minSeverity: z.enum(["low", "medium", "high"]).nullable().describe("anomalyGuard only: how unusual activity must be before it is held; default high"),
  sourcePhrase: z.string().describe("The exact words in the user's text this rule came from"),
});
const Draft = z.object({
  rules: z.array(DraftRule),
  ambiguities: z.array(z.object({ phrase: z.string(), question: z.string() })),
});
type DraftT = z.infer<typeof Draft>;

const SYSTEM = `You translate a person's plain-English spending instructions for their AI agent into structured rules.
Rule kinds:
- perTxLimit: no single payment over amountUsd.
- taskBudget: total for the current task (amountUsd).
- periodBudget: total per day/week/month (amountUsd + period).
- categories: only these purchase categories (${CATEGORIES.join(", ")}).
- allowlist: only pay these recipients (service ids or addresses).
- timeWindow: only spend between startHour and endHour (24h, end exclusive) on given days in tz.
- rateLimit: pause the agent if more than maxPerMinute payments in a minute.
- approvalThreshold: text the owner and hold payments above amountUsd.
- paused: stop all spending.
- anomalyGuard: hold payments for the owner when activity is unusual compared with the agent's own history (big jumps in amount, bursts, new recipients, budget burned fast, repeated denials, duplicate purchases). minSeverity: low|medium|high (default high). Use it only when the user explicitly asks to be asked about unusual or suspicious activity; it never replaces a number they gave.
Only emit rules the text actually states. Never invent limits. If a phrase is vague (e.g. "goes crazy", "a lot", "reasonable", "expensive"), do NOT guess a number: add it to ambiguities with a short clarifying question. If no timezone is given for a time window, use America/Chicago and add an ambiguity.`;

export async function compileRules(text: string): Promise<CompileResult> {
  if (!text.trim()) return { rules: [], ambiguities: [], model: "none", errors: ["Tell us your rules first."] };
  if (!config.llmApiKey) return finalize(offlineDraft(text), "offline-parser");
  const client = new Anthropic({ apiKey: config.llmApiKey });
  const res = await client.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: "low", format: zodOutputFormat(Draft) },
    system: SYSTEM,
    messages: [{ role: "user", content: `<instructions>\n${text.slice(0, 2000)}\n</instructions>` }],
  });
  if (res.stop_reason === "refusal" || !res.parsed_output) {
    return { rules: [], ambiguities: [], model: MODEL, errors: ["Couldn't understand those rules. Try rephrasing."] };
  }
  return finalize(res.parsed_output, MODEL);
}

/** Draft → validated Rule[]. Dollar → micro conversion happens here, deterministically. */
function finalize(draft: DraftT, model: string): CompileResult {
  const rules: Rule[] = [];
  const errors: string[] = [];
  const amb = [...draft.ambiguities];
  const seen = new Map<string, number>();
  const id = (k: string) => {
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return n === 1 ? k : `${k}-${n}`;
  };
  for (const d of draft.rules) {
    const money = () => {
      if (d.amountUsd == null) {
        amb.push({ phrase: d.sourcePhrase, question: "What dollar amount did you mean?" });
        return null;
      }
      return usdToMicro(d.amountUsd);
    };
    switch (d.kind) {
      case "perTxLimit": { const m = money(); if (m != null) rules.push({ id: id("per-payment"), kind: "perTxLimit", maxMicro: m }); break; }
      case "taskBudget": { const m = money(); if (m != null) rules.push({ id: id("task-budget"), kind: "taskBudget", taskId: "*", maxMicro: m }); break; }
      case "periodBudget": { const m = money(); if (m != null) rules.push({ id: id(`${d.period ?? "day"}-budget`), kind: "periodBudget", period: d.period ?? "day", maxMicro: m }); break; }
      case "approvalThreshold": { const m = money(); if (m != null) rules.push({ id: id("ask-first"), kind: "approvalThreshold", aboveMicro: m }); break; }
      case "categories": if (d.categories?.length) rules.push({ id: id("categories"), kind: "categories", allowed: d.categories }); break;
      case "allowlist": if (d.recipients?.length) rules.push({ id: id("approved-recipients"), kind: "allowlist", recipients: d.recipients.map((r) => r.trim().toLowerCase()) }); break;
      case "timeWindow":
        rules.push({ id: id("hours"), kind: "timeWindow", days: d.days ?? [], startHour: d.startHour ?? 0, endHour: d.endHour ?? 24, tz: d.tz ?? "America/Chicago" });
        break;
      case "rateLimit": if (d.maxPerMinute) rules.push({ id: id("rate-limit"), kind: "rateLimit", maxPerMinute: d.maxPerMinute, action: "pause" }); break;
      case "paused": rules.push({ id: id("paused"), kind: "paused" }); break;
      case "anomalyGuard": rules.push({ id: id("unusual-activity"), kind: "anomalyGuard", minSeverity: d.minSeverity ?? "high" }); break;
    }
  }
  const v = validateRules(rules);
  errors.push(...v.errors);
  return { rules: v.rules, ambiguities: amb, model, errors };
}

// ---------- Offline fallback (no API key): handles the common phrasings used in the demo. ----------
const VAGUE = ["goes crazy", "go crazy", "a lot", "too much", "reasonable", "expensive", "weird", "suspicious", "normal"];

export function offlineDraft(text: string): DraftT {
  const t = text.toLowerCase();
  const rules: DraftT["rules"] = [];
  const blank = { amountUsd: null, period: null, categories: null, recipients: null, days: null, startHour: null, endHour: null, tz: null, maxPerMinute: null, minSeverity: null };
  const money = "\\$\\s?(\\d+(?:\\.\\d+)?)";
  for (const s of t.split(/(?<=[.!;\n])\s+/)) {
    let m: RegExpMatchArray | null;
    if ((m = s.match(new RegExp(`${money}[^.]*?(?:for|on) (?:this|the|each|every) task`)))) rules.push({ ...blank, kind: "taskBudget", amountUsd: Number(m[1]), sourcePhrase: m[0] });
    if ((m = s.match(new RegExp(`${money}\\s*(?:a|per|each)\\s*(day|week|month)`)))) rules.push({ ...blank, kind: "periodBudget", amountUsd: Number(m[1]), period: m[2] as any, sourcePhrase: m[0] });
    if ((m = s.match(new RegExp(`(?:daily|weekly|monthly)[^$]*${money}`)))) {
      const p = m[0].startsWith("daily") ? "day" : m[0].startsWith("weekly") ? "week" : "month";
      rules.push({ ...blank, kind: "periodBudget", amountUsd: Number(m[1]), period: p, sourcePhrase: m[0] });
    }
    if ((m = s.match(new RegExp(`(?:text|ask|check with) me (?:before|first)[^$]*(?:over|above|more than) ${money}`)))) rules.push({ ...blank, kind: "approvalThreshold", amountUsd: Number(m[1]), sourcePhrase: m[0] });
    if ((m = s.match(new RegExp(`no (?:single )?payment (?:over|above|more than) ${money}`)))) rules.push({ ...blank, kind: "perTxLimit", amountUsd: Number(m[1]), sourcePhrase: m[0] });
    if ((m = s.match(/only (?:pay|use|buy from) ([a-z0-9_.\-x ,]+?)(?:\.|$)/))) {
      const recipients = m[1]!.split(/,|\band\b|\bor\b/).map((x) => x.trim()).filter(Boolean);
      rules.push({ ...blank, kind: "allowlist", recipients, sourcePhrase: m[0] });
    }
    if ((m = s.match(/only (?:buy|spend on) ((?:data|inference|compute|other)(?:(?:,| and| or) (?:data|inference|compute|other))*)/))) {
      rules.push({ ...blank, kind: "categories", categories: m[1]!.match(/data|inference|compute|other/g) as any, sourcePhrase: m[0] });
    }
    if ((m = s.match(/more than (\d+) (?:payments|purchases|times) (?:a|per) minute/))) rules.push({ ...blank, kind: "rateLimit", maxPerMinute: Number(m[1]), sourcePhrase: m[0] });
    if ((m = s.match(/(?:hold|flag|text me about|ask me about|check with me (?:on|about))[^.]*?\b(?:anything |activity that looks |spending that looks )?(?:unusual|anomalous|out of character)/))) rules.push({ ...blank, kind: "anomalyGuard", minSeverity: "high", sourcePhrase: m[0] });
    if ((m = s.match(/(?:between|from) (\d{1,2})\s*(am|pm)? (?:and|to|-|–) (\d{1,2})\s*(am|pm)/))) {
      const h = (n: number, ap?: string) => (ap === "pm" && n < 12 ? n + 12 : ap === "am" && n === 12 ? 0 : n);
      rules.push({ ...blank, kind: "timeWindow", startHour: h(Number(m[1]), m[2] ?? m[4]), endHour: h(Number(m[3]), m[4]), days: [], tz: "America/Chicago", sourcePhrase: m[0] });
    }
  }
  const ambiguities = VAGUE.filter((p) => t.includes(p)).map((phrase) => ({ phrase, question: `What exactly should count as "${phrase}"? Give a number (e.g. payments per minute or dollars).` }));
  return { rules, ambiguities };
}
