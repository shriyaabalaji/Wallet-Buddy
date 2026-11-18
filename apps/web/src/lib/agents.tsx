"use client";
// The selected agent, shared by every page. The shell polls the agent list (and owner health) once for the whole
// app; pages read them here instead of polling again. The choice is remembered per browser (localStorage).
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type AgentListItem, type ApiError, type Health } from "./api";
import { usePoll } from "./hooks";

const STORE = "af.agent";
const read = () => {
  try {
    return window.localStorage.getItem(STORE);
  } catch {
    return null;
  }
};
const write = (id: string) => {
  try {
    window.localStorage.setItem(STORE, id);
  } catch {
    /* private mode: selection just isn't remembered */
  }
};

type Ctx = {
  /** null while the first load is in flight. */
  agents: AgentListItem[] | null;
  agentsError: ApiError | null;
  refreshAgents: () => Promise<void>;
  /** The selected agent id, or null when no agents are registered (or not loaded yet). */
  agentId: string | null;
  agent: AgentListItem | null;
  selectAgent: (id: string) => void;
  health: Health | null;
};
const AgentContext = createContext<Ctx | null>(null);

export function AgentProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const { data, error, refresh } = usePoll(() => (enabled ? api<{ agents: AgentListItem[] }>("/v1/agents") : Promise.resolve(null)), 5000, enabled ? "on" : "off");
  const { data: health } = usePoll(() => (enabled ? api<Health>("/health") : Promise.resolve(null)), 15000, enabled ? "on" : "off");
  const [chosen, setChosen] = useState<string | null>(null);
  useEffect(() => setChosen(read()), []);

  const agents = data?.agents ?? null;
  // Fall back to the first agent when nothing (or an agent that no longer exists) is selected.
  const agentId = useMemo(() => {
    if (!agents || agents.length === 0) return null;
    return agents.some((a) => a.id === chosen) ? chosen : agents[0]!.id;
  }, [agents, chosen]);

  const selectAgent = useCallback((id: string) => {
    setChosen(id);
    write(id);
  }, []);

  const value: Ctx = {
    agents,
    agentsError: error,
    refreshAgents: refresh,
    agentId,
    agent: agents?.find((a) => a.id === agentId) ?? null,
    selectAgent,
    health: health ?? null,
  };
  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}

export function useAgents(): Ctx {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error("useAgents() must be used inside <AgentProvider>.");
  return ctx;
}
