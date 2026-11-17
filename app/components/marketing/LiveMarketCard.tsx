"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { MiniSparkline } from "./MiniSparkline";
import { useSpotPrices, useNowTick, ageSeconds } from "@/hooks/useSpotPrices";
import { SOL_MINT } from "@/lib/spotPrices";
import { isMockMode } from "@/lib/mock-mode";

/**
 * Homepage hero market card — REAL SOL spot price via the server-side
 * Jupiter aggregator (/api/prices/spot), polled every 10s.
 *
 * Honesty rules:
 * - The sparkline is built only from successive real polls observed
 *   by this client; with <2 points it renders a "collecting" state.
 * - The LIVE badge shows only when the data age is < 15s; otherwise
 *   the badge degrades to a grey STALE state.
 * - In mock mode the card is labeled MOCK and shows no price at all
 *   rather than presenting simulated numbers as live.
 */

const MAX_HISTORY_POINTS = 60;

export function LiveMarketCard({ className = "", animate = true }: { className?: string; animate?: boolean }) {
  const mock = isMockMode();
  const { prices, fetchedAt, stale, error } = useSpotPrices(
    mock ? [] : [SOL_MINT],
    10_000,
  );
  const now = useNowTick(1_000);
  const sol = prices[SOL_MINT];

  // Accumulate the real price series from successive polls.
  const [history, setHistory] = useState<number[]>([]);
  const lastFetchRef = useRef<number | null>(null);
  useEffect(() => {
    if (!sol || fetchedAt == null) return;
    if (lastFetchRef.current === fetchedAt) return;
    lastFetchRef.current = fetchedAt;
    setHistory((prev) => [...prev.slice(-(MAX_HISTORY_POINTS - 1)), sol.price]);
  }, [sol, fetchedAt]);

  const age = ageSeconds(fetchedAt, now);
  const isLive = !mock && sol != null && age != null && age < 15 && !stale && !error;
  const change = sol?.priceChange24h ?? null;
  const changeUp = change != null && change >= 0;

  return (
    <div className={`relative ${className}`}>
      {/* Ambient glow behind card */}
      <div
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            "radial-gradient(ellipse 400px 600px at 50% 50%, rgba(124,58,237,0.12), transparent)",
        }}
      />

      {/* Floating card */}
      <div
        className="w-full max-w-[380px] overflow-hidden border border-[var(--border)] bg-[var(--panel-bg)]"
        style={{
          animation: animate ? "market-card-float 4s ease-in-out infinite" : undefined,
          willChange: "transform",
          boxShadow: "0 0 40px rgba(153,69,255,0.08), 0 0 80px rgba(20,241,149,0.04)",
        }}
      >
        {/* Card header */}
        <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-5 py-3.5">
          <div className="flex items-center gap-3">
            <div
              className="flex h-8 w-8 items-center justify-center bg-[var(--accent)]/[0.10] border border-[var(--accent)]/20 text-xs font-bold text-[var(--accent)]"
              style={{ fontFamily: "var(--font-heading)" }}
            >
              S
            </div>
            <div>
              <div className="text-sm font-semibold text-[var(--text)]" style={{ fontFamily: "var(--font-heading)" }}>SOL-PERP</div>
              <div className="text-[10px] text-[var(--text-muted)]">
                Perpetual · 20x max
              </div>
            </div>
          </div>
          <div className="text-right">
            {mock ? (
              <div className="inline-flex items-center gap-1 border border-yellow-500/40 bg-yellow-500/10 px-2 py-0.5 text-[10px] font-bold text-yellow-500">
                MOCK
              </div>
            ) : isLive ? (
              <div className="inline-flex items-center gap-1 border border-[var(--long)]/30 bg-[var(--long)]/10 px-2 py-0.5 text-[10px] font-medium text-[var(--long)]">
                <span className="h-1.5 w-1.5 bg-[var(--long)] animate-pulse" />
                LIVE
              </div>
            ) : (
              <div className="inline-flex items-center gap-1 border border-[var(--text-muted)]/30 bg-[var(--text-muted)]/10 px-2 py-0.5 text-[10px] font-medium text-[var(--text-muted)]">
                <span className="h-1.5 w-1.5 bg-[var(--text-muted)]" />
                {sol ? "STALE" : "FEED OFFLINE"}
              </div>
            )}
            {change != null && !mock && (
              <div
                className={`mt-0.5 text-[11px] font-medium ${changeUp ? "text-[var(--long)]" : "text-[var(--short)]"}`}
                style={{ fontFamily: "var(--font-heading)" }}
              >
                {changeUp ? "+" : ""}{change.toFixed(2)}% {changeUp ? "↑" : "↓"}
                <span className="ml-1 text-[9px] font-normal text-[var(--text-muted)]">24h</span>
              </div>
            )}
          </div>
        </div>

        {/* Price + real sparkline */}
        <div className="px-5 pt-4">
          <div className="mb-2 flex items-baseline gap-2">
            <span
              className="text-[28px] font-semibold tracking-tight text-[var(--text)]"
              style={{ fontFamily: "var(--font-heading)" }}
            >
              {mock ? "—" : sol ? `$${sol.price.toFixed(2)}` : "—"}
            </span>
            {change != null && !mock && sol && (
              <span className={`text-xs ${changeUp ? "text-[var(--long)]" : "text-[var(--short)]"}`}>
                {changeUp ? "+" : ""}{change.toFixed(2)}%
              </span>
            )}
          </div>
          {mock ? (
            <div className="flex h-[120px] items-center justify-center text-center text-[11px] text-yellow-500/80">
              Mock mode — live prices hidden.
              <br />
              Simulated data is never shown as live.
            </div>
          ) : (
            <MiniSparkline width={340} height={120} points={history} />
          )}
          <div className="pb-1 pt-2 text-[10px] text-[var(--text-muted)]">
            {mock
              ? "SOL · mock mode"
              : sol && age != null
                ? `SOL · Jupiter · updated ${age}s ago`
                : "SOL · Jupiter · connecting…"}
          </div>
        </div>

        {/* Action buttons */}
        <div className="grid grid-cols-2 gap-2 px-5 pb-3 pt-2">
          <Link
            href="/markets"
            className="flex h-10 items-center justify-center border border-[var(--long)]/40 bg-[var(--long)]/[0.12] text-sm font-bold text-[var(--long)] transition-colors hover:bg-[var(--long)]/[0.20]"
          >
            LONG
          </Link>
          <Link
            href="/markets"
            className="flex h-10 items-center justify-center border border-[var(--short)]/40 bg-[var(--short)]/[0.12] text-sm font-bold text-[var(--short)] transition-colors hover:bg-[var(--short)]/[0.20]"
          >
            SHORT
          </Link>
        </div>

        {/* Card footer */}
        <div className="border-t border-[var(--border-subtle)] px-5 py-2.5 text-center text-[11px] text-[var(--text-muted)]">
          8% Creator Fee · Launch in 60s
        </div>
      </div>
    </div>
  );
}
