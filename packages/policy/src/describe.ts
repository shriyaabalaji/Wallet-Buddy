import { formatUsd } from "./money";
import type { Rule } from "./types";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hour = (n: number) => `${((n + 11) % 12) + 1}${n < 12 ? "am" : "pm"}`;

/** Who actually enforces a rule. Shown on the Rules page so users know what's hard vs. soft. */
export function enforcedBy(rule: Rule): string {
  switch (rule.kind) {
    // Circle Agent Wallet spending policies are mainnet-only (docs/RESEARCH.md), so on Arc testnet
    // every rule is enforced by the firewall (the only signer). Don't claim an outer wall we can't demo.
    case "allowlist":
      return "Agent Firewall + Arc ApprovalVault";
    case "approvalThreshold":
      return "Agent Firewall + Arc ApprovalVault";
    default:
      return "Agent Firewall";
  }
}

/** Plain-English sentence for a rule. No jargon. */
export function describeRule(rule: Rule): string {
  switch (rule.kind) {
    case "perTxLimit":
      return `No single payment over ${formatUsd(rule.maxMicro)}.`;
    case "taskBudget":
      return rule.taskId === "*" ? `Up to ${formatUsd(rule.maxMicro)} per task.` : `Up to ${formatUsd(rule.maxMicro)} for task "${rule.taskId}".`;
    case "periodBudget":
      return `Up to ${formatUsd(rule.maxMicro)} a ${rule.period}.`;
    case "categories":
      return `Only buy ${rule.allowed.join(", ")}.`;
    case "allowlist":
      return `Only pay ${rule.recipients.join(", ")}. ${rule.onViolation === "block" ? "Anyone else is blocked." : "Anyone else needs your OK."}`;
    case "timeWindow": {
      const days = rule.days.length === 0 || rule.days.length === 7 ? "any day" : rule.days.map((d) => DAY_NAMES[d]).join(", ");
      return `Only spend ${hour(rule.startHour)}–${hour(rule.endHour)} (${rule.tz}), ${days}.`;
    }
    case "rateLimit":
      return `Pause the agent if it makes more than ${rule.maxPerMinute} payments in a minute.`;
    case "approvalThreshold":
      return `Text me before any payment over ${formatUsd(rule.aboveMicro)}.`;
    case "paused":
      return "All spending is paused.";
    case "anomalyGuard": {
      const level = rule.minSeverity === "low" ? "even slightly unusual" : rule.minSeverity === "medium" ? "unusual" : "highly unusual";
      const which = rule.signals?.length ? ` (${rule.signals.map((s) => s.toLowerCase().replace(/_/g, " ")).join(", ")})` : "";
      return `${rule.onViolation === "block" ? "Block payments" : "Ask for your OK"} when spending looks ${level} for this agent${which}.`;
    }
  }
}
