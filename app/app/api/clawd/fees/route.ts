import { NextResponse } from "next/server";
import type { ClawdFees } from "@/lib/clawdFees";

export const dynamic = "force-dynamic";

/**
 * GET /api/clawd/fees
 *
 * Server-side proxy for the mainnet desk's $CLAWD creator-fee raise meter
 * (https://mainnet.percolator.tech/api/clawd/fees). The desk computes the
 * figures from the on-chain pump.fun creator-vault history; this route
 * exists so the launch homepage can show the raise progress without a
 * cross-origin dependency in the browser.
 *
 * Honesty contract (same pattern as /api/prices/spot):
 * - 30s server cache; the desk payload's own `fetchedAt`/`stale` pass
 *   through untouched so the UI ages the figure from the desk's read time,
 *   not from this proxy's cache time.
 * - If the desk read fails, a cached payload up to 5 minutes old is served
 *   with `stale: true` forced on.
 * - If the desk read fails and nothing is cached, the route returns 503
 *   and the UI renders NO figure — never a hard-coded fallback number.
 */

const UPSTREAM = "https://mainnet.percolator.tech/api/clawd/fees";
const CACHE_TTL_MS = 30_000;
const STALE_OK_MS = 300_000;

interface CacheEntry {
  data: ClawdFees;
  cachedAt: number;
}

let cache: CacheEntry | null = null;
let inflight: Promise<ClawdFees> | null = null;

function isClawdFees(raw: unknown): raw is ClawdFees {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r.raisedSol === "number" &&
    typeof r.remainingSol === "number" &&
    typeof r.goalSol === "number" &&
    typeof r.fetchedAt === "number"
  );
}

async function fetchFromDesk(): Promise<ClawdFees> {
  const res = await fetch(UPSTREAM, {
    signal: AbortSignal.timeout(8_000),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`clawd fees upstream returned ${res.status}`);
  }
  const raw: unknown = await res.json();
  if (!isClawdFees(raw)) {
    throw new Error("clawd fees upstream returned an unexpected shape");
  }
  return raw;
}

export async function GET() {
  const now = Date.now();

  if (cache && now - cache.cachedAt < CACHE_TTL_MS) {
    return NextResponse.json(cache.data);
  }

  try {
    if (!inflight) {
      inflight = fetchFromDesk().finally(() => {
        inflight = null;
      });
    }
    const data = await inflight;
    cache = { data, cachedAt: Date.now() };
    return NextResponse.json(data);
  } catch (err) {
    console.error("GET /api/clawd/fees error:", err);
    if (cache && now - cache.cachedAt < STALE_OK_MS) {
      // Serve the last good read, explicitly labeled stale. fetchedAt stays
      // the desk's original read time so the UI can age it honestly.
      return NextResponse.json({ ...cache.data, stale: true });
    }
    return NextResponse.json(
      { error: "clawd fees unavailable" },
      { status: 503 }
    );
  }
}
