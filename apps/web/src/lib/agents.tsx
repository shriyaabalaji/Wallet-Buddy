"use client";
// Every agent and the owner's health view, shared by every page. All agents pay from one wallet, so no page depends
// on a "selected" agent: the shell polls the agent list (and owner health) once for the whole app and pages read them
// here instead of polling again. The Agents page picks an agent from the URL (?id=).
import { createContext, useContext, type ReactNode } from "react";
import { api, type AgentListItem, type ApiError, type Health } from "./api";
import { usePoll } from "./hooks";

type Ctx = {
  /** null while the first load is in flight. */
  agents: AgentListItem[] | null;
  agentsError: ApiError | null;
  refreshAgents: () => Promise<void>;
  health: Health | null;
  /** Re-read /health now (e.g. after connecting a wallet) instead of waiting for the next poll. */
  refreshHealth: () => Promise<void>;
};
const AgentContext = createContext<Ctx | null>(null);

export function AgentProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const { data, error, refresh } = usePoll(() => (enabled ? api<{ agents: AgentListItem[] }>("/v1/agents") : Promise.resolve(null)), 5000, enabled ? "on" : "off");
  const { data: health, refresh: refreshHealth } = usePoll(() => (enabled ? api<Health>("/health") : Promise.resolve(null)), 15000, enabled ? "on" : "off");
  const value: Ctx = { agents: data?.agents ?? null, agentsError: error, refreshAgents: refresh, health: health ?? null, refreshHealth };
  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}

export function useAgents(): Ctx {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error("useAgents() must be used inside <AgentProvider>.");
  return ctx;
}
