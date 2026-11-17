"use client";

import { FC, useEffect, useMemo, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useWallets, useSignTransaction } from "@privy-io/react-auth/solana";
import { Connection, VersionedTransaction } from "@solana/web3.js";
import { usePrivyAvailable } from "@/hooks/usePrivySafe";
import { usePreferredWallet, resolveActiveWallet } from "@/hooks/usePreferredWallet";

/**
 * Buy $CLAWD widget — the same Jupiter Swap v2 widget that runs on
 * musebook.trade and the mainnet desk (order → review → simulate →
 * sign → execute), adapted to this app's Privy wallet stack.
 *
 * - $CLAWD trades on Solana MAINNET regardless of this app's default
 *   network, so signing pins chain "solana:mainnet" and simulation runs
 *   against the app's /api/rpc mainnet proxy.
 * - The displayed $CLAWD price comes from this app's /api/prices/spot
 *   (Jupiter Price v3) and is labeled with source + age.
 * - The sign step is user-side: nothing is signed or sent until the
 *   connected wallet owner confirms in Privy.
 */

const CLAWD_MINT = "8cHzQHUS2s2h8TzCmfqPKYiM4dSt4roa3n7MyRLApump";
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const CLAWD_DECIMALS = 6;
const SOL_DECIMALS = 9;

interface JupOrder {
  transaction: string;
  requestId: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  routePlan?: Array<{ swapInfo?: { label?: string } }>;
}

interface SpotState {
  price: number;
  priceChange24h: number | null;
  fetchedAt: number;
  stale: boolean;
}

interface QuotedTerms {
  side: "buy" | "sell";
  amount: string;
  slippageBps: number;
}

function fmtToken(raw: string, decimals: number): string {
  const n = Number(raw) / 10 ** decimals;
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function ageLabel(fetchedAt: number, now: number): string {
  const secs = Math.max(0, Math.floor((now - fetchedAt) / 1000));
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  return `${Math.floor(secs / 60)}m ago`;
}

const inputStyle =
  "w-full rounded-sm border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2.5 text-[13px] text-[var(--text)] placeholder:text-[var(--text-dim)] focus:border-[var(--accent)] focus:outline-none transition-colors";

export const BuyClawdWidget: FC = () => {
  const privyAvailable = usePrivyAvailable();
  const [spot, setSpot] = useState<SpotState | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/prices/spot?ids=${CLAWD_MINT}`);
        if (!res.ok) return;
        const data = await res.json();
        const entry = data?.prices?.[CLAWD_MINT];
        if (!cancelled && entry && typeof entry.price === "number") {
          setSpot({
            price: entry.price,
            priceChange24h:
              typeof entry.priceChange24h === "number"
                ? entry.priceChange24h
                : null,
            fetchedAt: typeof data.fetchedAt === "number" ? data.fetchedAt : Date.now(),
            stale: !!data.stale,
          });
        }
      } catch {
        // Price line simply stays at its last value / hidden.
      }
    }
    load();
    const poll = setInterval(load, 10_000);
    const tick = setInterval(() => setNow(Date.now()), 5_000);
    return () => {
      cancelled = true;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, []);

  return (
    <div className="flex h-full flex-col rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] p-6">
      <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
        {"// buy $CLAWD"}
      </div>
      <h3
        className="text-xl font-medium tracking-[-0.01em] text-[var(--text)] sm:text-2xl"
        style={{ fontFamily: "var(--font-heading)" }}
      >
        Buy and hold $CLAWD
      </h3>

      <div className="mt-3 text-[12px] text-[var(--text-secondary)]">
        {spot ? (
          <>
            $CLAWD{" "}
            <span className="text-[var(--text)]">
              $
              {spot.price.toLocaleString(undefined, {
                maximumFractionDigits: 8,
              })}
            </span>
            {spot.priceChange24h != null && (
              <span
                className={
                  spot.priceChange24h >= 0
                    ? " text-[var(--long)]"
                    : " text-[var(--short)]"
                }
              >
                {" "}
                {spot.priceChange24h >= 0 ? "+" : ""}
                {spot.priceChange24h.toFixed(2)}% 24h
              </span>
            )}
            <span className="text-[var(--text-muted)]">
              {" "}
              · Jupiter · updated {ageLabel(spot.fetchedAt, now)}
              {spot.stale ? " · stale" : ""}
            </span>
          </>
        ) : (
          <span className="text-[var(--text-muted)]">
            $CLAWD price loading…
          </span>
        )}
      </div>

      <div className="mt-5 flex-1">
        {privyAvailable ? (
          <TradeControls />
        ) : (
          <button
            disabled
            className="w-full rounded-sm border border-[var(--border)] px-4 py-2.5 text-[13px] font-medium text-[var(--text-muted)] opacity-50"
          >
            Wallet unavailable
          </button>
        )}
      </div>

      <p className="mt-5 text-[11px] leading-relaxed text-[var(--text-muted)]">
        Swaps route through Jupiter on Solana mainnet and are signed in your
        own wallet — the site never takes custody. Every $CLAWD trade pays
        creator fees toward the mainnet deploy raise.
      </p>
    </div>
  );
};

/**
 * Inner trade controls — only mounted when PrivyProvider is live, so the
 * Privy hooks below always run inside the provider tree.
 */
const TradeControls: FC = () => {
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const { signTransaction } = useSignTransaction();
  const { preferredAddress } = usePreferredWallet();

  const activeWallet = useMemo(
    () => resolveActiveWallet(wallets, preferredAddress),
    [wallets, preferredAddress]
  );

  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(50);
  const [order, setOrder] = useState<JupOrder | null>(null);
  const [quotedTerms, setQuotedTerms] = useState<QuotedTerms | null>(null);
  const [busy, setBusy] = useState<"quote" | "exec" | null>(null);
  const [error, setError] = useState("");
  const [successSig, setSuccessSig] = useState("");

  // Terms freeze: any change to amount / slippage / side after quoting
  // invalidates the quote, so what gets signed is always what was reviewed.
  useEffect(() => {
    if (
      quotedTerms &&
      (quotedTerms.side !== side ||
        quotedTerms.amount !== amount ||
        quotedTerms.slippageBps !== slippageBps)
    ) {
      setOrder(null);
      setQuotedTerms(null);
      setSuccessSig("");
    }
  }, [side, amount, slippageBps, quotedTerms]);

  const inDecimals = side === "buy" ? SOL_DECIMALS : CLAWD_DECIMALS;
  const outDecimals = side === "buy" ? CLAWD_DECIMALS : SOL_DECIMALS;
  const inSymbol = side === "buy" ? "SOL" : "$CLAWD";
  const outSymbol = side === "buy" ? "$CLAWD" : "SOL";

  async function getQuote() {
    setError("");
    setSuccessSig("");
    if (!authenticated || !activeWallet) {
      login();
      return;
    }
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError("Enter an amount first.");
      return;
    }
    const rawAmount = Math.round(amt * 10 ** inDecimals);
    if (rawAmount <= 0) {
      setError("Amount is too small.");
      return;
    }
    setBusy("quote");
    try {
      const inputMint = side === "buy" ? WSOL_MINT : CLAWD_MINT;
      const outputMint = side === "buy" ? CLAWD_MINT : WSOL_MINT;
      const url =
        `https://api.jup.ag/swap/v2/order?inputMint=${inputMint}` +
        `&outputMint=${outputMint}&amount=${rawAmount}` +
        `&taker=${activeWallet.address}&slippageBps=${slippageBps}`;
      const res = await fetch(url);
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.transaction || !data?.requestId) {
        throw new Error(data?.error || `Jupiter order failed (${res.status})`);
      }
      setOrder(data as JupOrder);
      setQuotedTerms({ side, amount, slippageBps });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Quote failed.");
    } finally {
      setBusy(null);
    }
  }

  async function execute() {
    setError("");
    if (!order || !activeWallet) return;
    setBusy("exec");
    try {
      const tx = VersionedTransaction.deserialize(
        Buffer.from(order.transaction, "base64")
      );

      // Simulate before asking for a signature — a trade that cannot land
      // is never put in front of the user's wallet.
      const connection = new Connection(
        `${window.location.origin}/api/rpc?network=mainnet`,
        "confirmed"
      );
      const sim = await connection.simulateTransaction(tx);
      if (sim.value.err) {
        throw new Error(
          `Simulation failed (${JSON.stringify(sim.value.err)}) — trade not signed.`
        );
      }

      const { signedTransaction } = await signTransaction({
        transaction: tx.serialize(),
        wallet: activeWallet,
        // $CLAWD trades settle on mainnet even though this app defaults to
        // devnet for its own markets — pin the chain explicitly.
        chain: "solana:mainnet",
      });

      const res = await fetch("https://api.jup.ag/swap/v2/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          signedTransaction: Buffer.from(signedTransaction).toString("base64"),
          requestId: order.requestId,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || data?.status !== "success" || !data?.signature) {
        throw new Error(data?.error || `Execute failed (${res.status})`);
      }
      setSuccessSig(data.signature as string);
      setOrder(null);
      setQuotedTerms(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Trade failed.");
    } finally {
      setBusy(null);
    }
  }

  if (!ready) {
    return (
      <p className="text-[13px] text-[var(--text-muted)]">Loading wallet…</p>
    );
  }

  if (!authenticated || !activeWallet) {
    return (
      <button
        onClick={() => login()}
        className="w-full rounded-sm bg-[var(--accent)] px-4 py-2.5 text-[13px] font-semibold text-black transition-opacity hover:opacity-90"
      >
        Connect wallet to trade
      </button>
    );
  }

  return (
    <div>
      <div className="mb-3 grid grid-cols-2 gap-px border border-[var(--border)] bg-[var(--border)]">
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSide(s)}
            className={`px-3 py-2 text-[12px] font-semibold uppercase tracking-wider transition-colors ${
              side === s
                ? s === "buy"
                  ? "bg-[var(--long)]/15 text-[var(--long)]"
                  : "bg-[var(--short)]/15 text-[var(--short)]"
                : "bg-[var(--panel-bg)] text-[var(--text-muted)] hover:text-[var(--text)]"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.15em] text-[var(--text-muted)]">
        You pay ({inSymbol})
      </label>
      <input
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        inputMode="decimal"
        placeholder="0.0"
        className={inputStyle}
      />

      <div className="mt-3 flex items-center gap-2">
        <label className="text-[11px] font-medium uppercase tracking-[0.15em] text-[var(--text-muted)]">
          Slippage
        </label>
        {[10, 50, 100].map((bps) => (
          <button
            key={bps}
            onClick={() => setSlippageBps(bps)}
            className={`border px-2 py-1 text-[11px] transition-colors ${
              slippageBps === bps
                ? "border-[var(--accent)] text-[var(--text)]"
                : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]"
            }`}
          >
            {bps / 100}%
          </button>
        ))}
      </div>

      {order && (
        <div className="mt-4 border border-[var(--border)] bg-[var(--bg-elevated)] p-3 text-[12px] leading-relaxed text-[var(--text-secondary)]">
          <div>
            You receive ≈{" "}
            <span className="text-[var(--text)]">
              {fmtToken(order.outAmount, outDecimals)} {outSymbol}
            </span>
          </div>
          <div>
            Minimum receive: {fmtToken(order.otherAmountThreshold, outDecimals)}{" "}
            {outSymbol}
          </div>
          <div>
            Price impact: {parseFloat(order.priceImpactPct || "0").toFixed(3)}%
          </div>
          {order.routePlan?.[0]?.swapInfo?.label && (
            <div>Route: {order.routePlan[0].swapInfo.label}</div>
          )}
        </div>
      )}

      {error && (
        <p className="mt-3 text-[12px] leading-relaxed text-[var(--short)]">
          {error}
        </p>
      )}
      {successSig && (
        <p className="mt-3 text-[12px] leading-relaxed text-[var(--long)]">
          Trade landed.{" "}
          <a
            href={`https://solscan.io/tx/${successSig}`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            View on Solscan
          </a>
        </p>
      )}

      {order ? (
        <button
          onClick={execute}
          disabled={busy !== null}
          className="mt-4 w-full rounded-sm bg-[var(--accent)] px-4 py-2.5 text-[13px] font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy === "exec" ? "Simulating & signing…" : `Review & ${side} ${outSymbol === "$CLAWD" ? "$CLAWD" : "SOL"}`}
        </button>
      ) : (
        <button
          onClick={getQuote}
          disabled={busy !== null}
          className="mt-4 w-full rounded-sm bg-[var(--accent)] px-4 py-2.5 text-[13px] font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy === "quote" ? "Getting quote…" : "Get quote"}
        </button>
      )}
    </div>
  );
};
