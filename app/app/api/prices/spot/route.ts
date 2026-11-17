import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import {
  DEFAULT_SPOT_MINTS,
  MAX_SPOT_MINTS,
  type SpotPrice,
  type SpotPricesResponse,
} from "@/lib/spotPrices";

export const dynamic = "force-dynamic";

/**
 * GET /api/prices/spot?ids=<mint>,<mint>,...
 *
 * Server-side Jupiter Price v3 aggregator. Returns mainnet SPOT
 * reference prices (NOT slab/oracle prices) for up to 50 mints:
 *
 *   { prices: { [mint]: { price, priceChange24h, liquidity, decimals,
 *                         blockId, source: "Jupiter" } },
 *     fetchedAt, source: "Jupiter", stale?: boolean }
 *
 * - No ids param → SOL, USDC, $CLAWD.
 * - 8s server cache (per id-set) so client polling at 10s doesn't
 *   hammer Jupiter; on upstream failure a cached entry up to 60s old
 *   is served with `stale: true` and its ORIGINAL fetchedAt, so the
 *   UI can age it honestly instead of presenting it as fresh.
 * - Keyless lite-api endpoint by default; if JUPITER_API_KEY is set
 *   server-side, the keyed api.jup.ag endpoint is used instead.
 *   Keys never reach the client.
 */

const CACHE_TTL_MS = 8_000;
const STALE_OK_MS = 60_000;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

interface CacheEntry {
  data: SpotPricesResponse;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<SpotPricesResponse>>();

interface JupiterEntry {
  usdPrice?: number;
  blockId?: number;
  decimals?: number;
  priceChange24h?: number;
  liquidity?: number;
}

async function fetchFromJupiter(ids: string[]): Promise<SpotPricesResponse> {
  const apiKey = process.env.JUPITER_API_KEY;
  const base = apiKey
    ? "https://api.jup.ag/price/v3"
    : "https://lite-api.jup.ag/price/v3";
  const url = `${base}?ids=${ids.join(",")}`;

  const res = await fetch(url, {
    headers: apiKey ? { "x-api-key": apiKey } : {},
    signal: AbortSignal.timeout(5_000),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Jupiter price API returned ${res.status}`);
  }

  const raw = (await res.json()) as Record<string, JupiterEntry>;
  const prices: Record<string, SpotPrice> = {};
  for (const [mint, entry] of Object.entries(raw)) {
    if (entry && typeof entry.usdPrice === "number" && entry.usdPrice > 0) {
      prices[mint] = {
        price: entry.usdPrice,
        priceChange24h:
          typeof entry.priceChange24h === "number" ? entry.priceChange24h : null,
        liquidity: typeof entry.liquidity === "number" ? entry.liquidity : null,
        decimals: typeof entry.decimals === "number" ? entry.decimals : 6,
        blockId: typeof entry.blockId === "number" ? entry.blockId : null,
        source: "Jupiter",
      };
    }
  }

  return { prices, fetchedAt: Date.now(), source: "Jupiter" };
}

export async function GET(req: NextRequest) {
  const idsParam = req.nextUrl.searchParams.get("ids");
  const requested = idsParam
    ? idsParam
        .split(",")
        .map((s) => s.trim())
        .filter((s) => BASE58_RE.test(s))
    : [...DEFAULT_SPOT_MINTS];

  const ids = [...new Set(requested)].slice(0, MAX_SPOT_MINTS);
  if (ids.length === 0) {
    return NextResponse.json(
      { error: "No valid mint ids" },
      { status: 400, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  const cacheKey = [...ids].sort().join(",");
  const now = Date.now();
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > now) {
    return NextResponse.json(hit.data, {
      headers: { "Cache-Control": "public, max-age=5" },
    });
  }

  try {
    let pending = inflight.get(cacheKey);
    if (!pending) {
      pending = fetchFromJupiter(ids).finally(() => {
        inflight.delete(cacheKey);
      });
      inflight.set(cacheKey, pending);
    }
    const data = await pending;
    cache.set(cacheKey, { data, expiresAt: Date.now() + CACHE_TTL_MS });
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, max-age=5" },
    });
  } catch (err) {
    // Serve a recent cache entry rather than nothing — flagged stale
    // with its original fetchedAt so clients age it honestly.
    if (hit && now - hit.data.fetchedAt <= STALE_OK_MS) {
      return NextResponse.json(
        { ...hit.data, stale: true },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    }
    Sentry.captureException(err, { tags: { endpoint: "/api/prices/spot" } });
    return NextResponse.json(
      { error: "Spot price fetch failed" },
      { status: 502, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
