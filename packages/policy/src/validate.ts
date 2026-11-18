import { ANOMALY_SEVERITIES, ANOMALY_TYPES, CATEGORIES, type Rule } from "./types";

/**
 * Strict runtime validation for rules coming from the LLM compiler or the API.
 * Returns a list of human-readable problems; empty means valid.
 */
export function validateRules(input: unknown): { rules: Rule[]; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(input)) return { rules: [], errors: ["rules must be an array"] };
  const ids = new Set<string>();
  const rules: Rule[] = [];
  input.forEach((r: any, i) => {
    const at = `rule[${i}]`;
    if (!r || typeof r !== "object") return errors.push(`${at}: not an object`);
    if (typeof r.id !== "string" || !r.id) return errors.push(`${at}: missing id`);
    if (ids.has(r.id)) return errors.push(`${at}: duplicate id ${r.id}`);
    ids.add(r.id);
    if (r.onViolation !== undefined && r.onViolation !== "block" && r.onViolation !== "hold") return errors.push(`${at}: bad onViolation`);
    const money = (k: string) => Number.isSafeInteger(r[k]) && r[k] >= 0;
    switch (r.kind) {
      case "perTxLimit":
        if (!money("maxMicro")) return errors.push(`${at}: maxMicro must be a non-negative integer`);
        break;
      case "taskBudget":
        if (!money("maxMicro")) return errors.push(`${at}: maxMicro must be a non-negative integer`);
        if (typeof r.taskId !== "string" || !r.taskId) return errors.push(`${at}: taskId required ("*" for every task)`);
        break;
      case "periodBudget":
        if (!money("maxMicro")) return errors.push(`${at}: maxMicro must be a non-negative integer`);
        if (!["day", "week", "month"].includes(r.period)) return errors.push(`${at}: period must be day|week|month`);
        break;
      case "categories":
        if (!Array.isArray(r.allowed) || r.allowed.length === 0 || !r.allowed.every((c: any) => (CATEGORIES as readonly string[]).includes(c)))
          return errors.push(`${at}: allowed must be a non-empty subset of ${CATEGORIES.join(",")}`);
        break;
      case "allowlist":
        if (!Array.isArray(r.recipients) || r.recipients.length === 0 || !r.recipients.every((x: any) => typeof x === "string" && x.length > 0))
          return errors.push(`${at}: recipients must be a non-empty list of strings`);
        break;
      case "timeWindow":
        if (!Array.isArray(r.days) || !r.days.every((d: any) => Number.isInteger(d) && d >= 0 && d <= 6)) return errors.push(`${at}: days must be 0-6`);
        if (![r.startHour, r.endHour].every((h) => Number.isInteger(h) && h >= 0 && h <= 24)) return errors.push(`${at}: hours must be 0-24`);
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: r.tz });
        } catch {
          return errors.push(`${at}: unknown timezone ${r.tz}`);
        }
        break;
      case "rateLimit":
        if (!Number.isInteger(r.maxPerMinute) || r.maxPerMinute < 1) return errors.push(`${at}: maxPerMinute must be >= 1`);
        if (r.action !== "pause") return errors.push(`${at}: action must be "pause"`);
        break;
      case "approvalThreshold":
        if (!money("aboveMicro")) return errors.push(`${at}: aboveMicro must be a non-negative integer`);
        break;
      case "paused":
        break;
      case "anomalyGuard":
        if (r.minSeverity !== undefined && !(ANOMALY_SEVERITIES as readonly string[]).includes(r.minSeverity)) return errors.push(`${at}: minSeverity must be ${ANOMALY_SEVERITIES.join("|")}`);
        if (r.signals !== undefined && (!Array.isArray(r.signals) || !r.signals.every((s: any) => (ANOMALY_TYPES as readonly string[]).includes(s))))
          return errors.push(`${at}: signals must be a list of ${ANOMALY_TYPES.join(", ")}`);
        break;
      default:
        return errors.push(`${at}: unknown kind ${r.kind}`);
    }
    rules.push(r as Rule);
  });
  return { rules, errors };
}
