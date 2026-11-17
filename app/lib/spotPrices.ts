/**
 * Spot price types + well-known mints for the Jupiter-backed spot
 * reference feed served by GET /api/prices/spot.
 *
 * These are REFERENCE prices (mainnet spot via Jupiter Price v3).
 * They are never a market's slab/oracle price — UI must label them
 * with source + age wherever they are displayed.
 */

export interface SpotPrice {
  /** USD price (float) */
  price: number;
  /** 24h % change, or null when Jupiter doesn't report one */
  priceChange24h: number | null;
  /** Pool liquidity in USD, or null */
  liquidity: number | null;
  /** Token decimals */
  decimals: number;
  /** Solana slot (Jupiter blockId) the price was computed at */
  blockId: number | null;
  source: "Jupiter";
}

export interface SpotPricesResponse {
  prices: Record<string, SpotPrice>;
  /** Server fetch time (ms epoch) of the Jupiter read */
  fetchedAt: number;
  source: "Jupiter";
  /** True when served from cache after a failed upstream refresh */
  stale?: boolean;
}

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const CLAWD_MINT = "8cHzQHUS2s2h8TzCmfqPKYiM4dSt4roa3n7MyRLApump";

/** Default set returned by /api/prices/spot when no ids are requested. */
export const DEFAULT_SPOT_MINTS = [SOL_MINT, USDC_MINT, CLAWD_MINT];

/** Max mints per spot request (matches Jupiter Price v3 guidance). */
export const MAX_SPOT_MINTS = 50;
