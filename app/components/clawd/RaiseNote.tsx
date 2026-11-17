"use client";

import { FC, useEffect, useState } from "react";
import type { ClawdFees } from "@/lib/clawdFees";

/**
 * "15 SOL away from deploying" raise note.
 *
 * Every figure comes live from /api/clawd/fees (server proxy of the
 * mainnet desk's on-chain creator-fee meter). If the read fails and no
 * cached value exists, the note renders NO figure — never a hard-coded
 * number presented as the live state.
 */

function fmtSol(n: number): string {
  return parseFloat(n.toFixed(3)).toString();
}

function ageLabel(fetchedAt: number, now: number): string {
  const secs = Math.max(0, Math.floor((now - fetchedAt) / 1000));
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

export const RaiseNote: FC = () => {
  const [fees, setFees] = useState<ClawdFees | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/clawd/fees");
        if (!res.ok) throw new Error(`fees ${res.status}`);
        const data = (await res.json()) as ClawdFees;
        if (!cancelled) {
          setFees(data);
          setFailed(false);
        }
      } catch {
        // Keep any previously loaded figure (the proxy already labels
        // stale cache); only flag failure when we have nothing to show.
        if (!cancelled) setFailed(true);
      }
    }
    load();
    const poll = setInterval(load, 60_000);
    const tick = setInterval(() => setNow(Date.now()), 10_000);
    return () => {
      cancelled = true;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, []);

  return (
    <div className="flex h-full flex-col rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] p-6">
      <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
        {"// mainnet raise"}
      </div>

      {fees ? (
        <>
          <h3
            className="text-xl font-medium tracking-[-0.01em] text-[var(--text)] sm:text-2xl"
            style={{ fontFamily: "var(--font-heading)" }}
          >
            {fees.goalReached ? (
              <>The {fmtSol(fees.goalSol)} SOL deploy fund is covered.</>
            ) : (
              <>
                We&apos;re {fmtSol(fees.remainingSol)} SOL of fees away from
                deploying mainnet
              </>
            )}
          </h3>

          <div className="mt-5">
            <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--bg-elevated)]">
              <div
                className="h-full rounded-full bg-[var(--accent)] transition-all duration-500"
                style={{
                  width: `${Math.min(100, Math.max(0, fees.pct))}%`,
                }}
              />
            </div>
            <div className="mt-2 flex items-center justify-between text-[12px] text-[var(--text-secondary)]">
              <span>
                Raised {fmtSol(fees.raisedSol)} of {fmtSol(fees.goalSol)} SOL
              </span>
              <span>{parseFloat(fees.pct.toFixed(1))}%</span>
            </div>
          </div>

          <p className="mt-5 text-[13px] leading-relaxed text-[var(--text-secondary)]">
            Help get us there: buy and hold $CLAWD — every trade&apos;s
            creator fees fund the deploy. The counter above counts only fees
            earned since the raise baseline; the lifetime total is{" "}
            {fmtSol(fees.earnedSol)} SOL.
          </p>

          <div className="mt-auto pt-5 text-[11px] text-[var(--text-muted)]">
            {fees.source} · updated {ageLabel(fees.fetchedAt, now)}
            {fees.stale && (
              <span className="ml-2 border border-[var(--warning)]/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[var(--warning)]">
                stale
              </span>
            )}
          </div>
        </>
      ) : failed ? (
        <>
          <h3
            className="text-xl font-medium tracking-[-0.01em] text-[var(--text)] sm:text-2xl"
            style={{ fontFamily: "var(--font-heading)" }}
          >
            Help launch Percolator mainnet
          </h3>
          <p className="mt-5 text-[13px] leading-relaxed text-[var(--text-secondary)]">
            Buy and hold $CLAWD — every trade&apos;s creator fees fund the
            mainnet deploy.
          </p>
          <p className="mt-auto pt-5 text-[11px] text-[var(--text-muted)]">
            Live raise progress is unavailable right now — the fee meter
            couldn&apos;t be read, so no figure is shown.
          </p>
        </>
      ) : (
        <p className="text-[13px] text-[var(--text-muted)]">
          Loading live raise progress…
        </p>
      )}
    </div>
  );
};
