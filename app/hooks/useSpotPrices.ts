"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SpotPrice, SpotPricesResponse } from "@/lib/spotPrices";

export interface SpotPricesState {
  prices: Record<string, SpotPrice>;
  /** Server fetch time (ms epoch) of the data in `prices` */
  fetchedAt: number | null;
  /** Server flagged this payload as a stale-cache fallback */
  stale: boolean;
  loading: boolean;
  error: boolean;
}

/**
 * Poll the server-side Jupiter spot aggregator (/api/prices/spot).
 *
 * These are mainnet spot REFERENCE prices — not slab/oracle prices.
 * Consumers must label them with source + age and must hide (not
 * freeze) USD equivalents when the data is too old.
 */
export function useSpotPrices(
  mints: string[],
  pollMs = 10_000,
): SpotPricesState {
  const key = useMemo(
    () => [...new Set(mints.filter(Boolean))].sort().join(","),
    [mints],
  );
  const [state, setState] = useState<SpotPricesState>({
    prices: {},
    fetchedAt: null,
    stale: false,
    loading: key.length > 0,
    error: false,
  });
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!key) {
      setState({ prices: {}, fetchedAt: null, stale: false, loading: false, error: false });
      return;
    }

    let cancelled = false;

    const load = async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await fetch(`/api/prices/spot?ids=${key}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`spot ${res.status}`);
        const data = (await res.json()) as SpotPricesResponse;
        if (cancelled) return;
        setState({
          prices: data.prices ?? {},
          fetchedAt: data.fetchedAt ?? Date.now(),
          stale: data.stale === true,
          loading: false,
          error: false,
        });
      } catch {
        if (cancelled) return;
        // Keep last good prices (their fetchedAt keeps aging honestly)
        // but flag the error so freshness UIs can degrade.
        setState((s) => ({ ...s, loading: false, error: true }));
      }
    };

    setState((s) => ({ ...s, loading: s.fetchedAt === null }));
    void load();
    const id = setInterval(load, pollMs);
    return () => {
      cancelled = true;
      clearInterval(id);
      abortRef.current?.abort();
    };
  }, [key, pollMs]);

  return state;
}

/** Re-render every `intervalMs` so "updated Xs ago" labels stay honest. */
export function useNowTick(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Whole seconds between a fetch timestamp and now (never negative). */
export function ageSeconds(fetchedAt: number | null, now: number): number | null {
  if (fetchedAt == null) return null;
  return Math.max(0, Math.floor((now - fetchedAt) / 1000));
}
