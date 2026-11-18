"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api";

/**
 * Poll an async loader. Keeps the last good data when a poll fails and exposes the error.
 * Skips polls while the tab is hidden (and refreshes on return), so idle tabs don't load the firewall.
 * Changing `key` (e.g. the selected agent) drops the old data and loads immediately.
 */
export function usePoll<T>(load: () => Promise<T>, intervalMs: number, key = "") {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const keyRef = useRef(key);

  const refresh = useCallback(async () => {
    const forKey = keyRef.current;
    try {
      const next = await loadRef.current();
      if (forKey !== keyRef.current) return; // a response for the previous agent arrived late
      setData(next);
      setError(null);
    } catch (e) {
      if (forKey !== keyRef.current) return;
      setError(e instanceof ApiError ? e : new ApiError("Something went wrong.", 0));
    }
  }, []);

  useEffect(() => {
    keyRef.current = key;
    setData(null);
    setError(null);
    void refresh();
    const id = setInterval(() => {
      if (typeof document === "undefined" || !document.hidden) void refresh();
    }, intervalMs);
    const onShow = () => !document.hidden && void refresh();
    document.addEventListener("visibilitychange", onShow);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [refresh, intervalMs, key]);

  return { data, error, refresh };
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
