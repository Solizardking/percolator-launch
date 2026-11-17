'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { isMockMode } from '@/lib/mock-mode';
import { isBlockedSlab } from '@/lib/blocklist';

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface MarketVaultInfo {
  slabAddress: string;
  symbol: string;
  name: string;
  /**
   * Whether this market's stake pool exists on-chain (from /api/stake/pools).
   * False means the Earn vault was never initialized — the UI must label it
   * truthfully instead of offering a deposit form.
   */
  poolExists: boolean;
  /** Stake-pool vault collateral balance (raw base units, read on-chain) */
  vaultBalance: number;
  /** Total open interest (long + short, in USD) */
  totalOI: number;
  /** Max OI capacity (based on LP capital × max leverage) */
  maxOI: number;
  /** Insurance fund balance */
  insuranceFund: number;
  /** 24h volume in USD */
  volume24h: number;
  /** Trading fee bps (0 when the serving data doesn't carry it) */
  tradingFeeBps: number;
  /** Max leverage (0 when the serving data doesn't carry it) */
  maxLeverage: number;
  /** Annualised APY estimate based on fee revenue */
  estimatedApyPct: number;
  /** OI utilization percentage (totalOI / maxOI × 100) */
  oiUtilPct: number;
  /** Collateral token decimals */
  decimals: number;
}

export interface EarnStats {
  /** Total value locked across all vaults */
  tvl: number;
  /** Platform-wide total OI */
  totalOI: number;
  /** Platform-wide max OI capacity */
  maxOI: number;
  /** Platform-wide average APY */
  avgApyPct: number;
  /** Platform-wide OI utilization */
  oiUtilPct: number;
  /** Insurance fund total */
  totalInsurance: number;
  /** Per-market vault breakdown */
  markets: MarketVaultInfo[];
  /** Total 24h fee revenue estimate (USD) */
  dailyFeeRevenue: number;
  /**
   * Whether avgApyPct is computed from real vault/fee data.
   * False when there are no markets with actual deposits — the UI must
   * render "not available" instead of a numeric APY in that case.
   */
  avgApyAvailable: boolean;
}

const DEFAULT_STATS: EarnStats = {
  tvl: 0,
  totalOI: 0,
  maxOI: 0,
  avgApyPct: 0,
  oiUtilPct: 0,
  totalInsurance: 0,
  markets: [],
  dailyFeeRevenue: 0,
  avgApyAvailable: false,
};

// ═══════════════════════════════════════════════════════════════
// API row shapes
//
// Numeric fields may arrive as strings (Supabase NUMERIC columns
// serialize as strings through /api/markets), so every numeric read
// goes through numOr().
// ═══════════════════════════════════════════════════════════════

interface MarketsApiRow {
  slab_address?: string | null;
  symbol?: string | null;
  name?: string | null;
  decimals?: number | string | null;
  max_leverage?: number | string | null;
  trading_fee_bps?: number | string | null;
  insurance_fund?: number | string | null;
  volume_24h?: number | string | null;
  total_open_interest?: number | string | null;
  open_interest_long?: number | string | null;
  open_interest_short?: number | string | null;
}

interface StakePoolsApiRow {
  slabAddress: string;
  /** Raw SPL token amount in the pool vault (base units), as a string */
  tvlRaw?: string | null;
  /** Trailing APR % computed by /api/stake/pools (0 without history) */
  apr?: number | null;
}

/** Coerce an API numeric (number | string | null) to a number with fallback. */
function numOr(v: number | string | null | undefined, fallback: number): number {
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ═══════════════════════════════════════════════════════════════
// Mock data — EXPLICIT MOCK MODE ONLY (isMockMode: env flag or ?mock=1,
// both covered by the site-wide mock banner). Never used as a fallback
// for missing/erroring live data.
// ═══════════════════════════════════════════════════════════════

function generateMockStats(): EarnStats {
  const markets: MarketVaultInfo[] = [
    {
      slabAddress: 'mock-sol-perp',
      symbol: 'SOL',
      name: 'Solana',
      vaultBalance: 125_000_000_000, // 125 SOL
      totalOI: 45_200,
      maxOI: 250_000,
      insuranceFund: 12_000_000_000,
      volume24h: 128_450,
      tradingFeeBps: 10,
      maxLeverage: 20,
      estimatedApyPct: 18.7,
      oiUtilPct: 18.1, decimals: 9, poolExists: true,
    },
    {
      slabAddress: 'mock-bonk-perp',
      symbol: 'BONK',
      name: 'Bonk',
      vaultBalance: 85_000_000_000,
      totalOI: 22_100,
      maxOI: 170_000,
      insuranceFund: 5_000_000_000,
      volume24h: 89_200,
      tradingFeeBps: 15,
      maxLeverage: 10,
      estimatedApyPct: 24.3,
      oiUtilPct: 13.0, decimals: 6, poolExists: true,
    },
    {
      slabAddress: 'mock-wif-perp',
      symbol: 'WIF',
      name: 'dogwifhat',
      vaultBalance: 42_000_000_000,
      totalOI: 15_800,
      maxOI: 84_000,
      insuranceFund: 3_500_000_000,
      volume24h: 67_300,
      tradingFeeBps: 15,
      maxLeverage: 10,
      estimatedApyPct: 31.2,
      oiUtilPct: 18.8, decimals: 6, poolExists: true,
    },
    {
      slabAddress: 'mock-jup-perp',
      symbol: 'JUP',
      name: 'Jupiter',
      vaultBalance: 38_000_000_000,
      totalOI: 9_400,
      maxOI: 76_000,
      insuranceFund: 2_800_000_000,
      volume24h: 41_600,
      tradingFeeBps: 12,
      maxLeverage: 15,
      estimatedApyPct: 15.8,
      oiUtilPct: 12.4, decimals: 6, poolExists: true,
    },
  ];

  const tvl = markets.reduce((s, m) => s + m.vaultBalance / (10 ** m.decimals), 0);
  const totalOI = markets.reduce((s, m) => s + m.totalOI, 0);
  const maxOI = markets.reduce((s, m) => s + m.maxOI, 0);
  const totalInsurance = markets.reduce((s, m) => s + m.insuranceFund / (10 ** m.decimals), 0);
  const dailyFeeRevenue = markets.reduce(
    (s, m) => s + (m.volume24h * m.tradingFeeBps) / 10_000,
    0,
  );

  const avgApy =
    markets.length > 0
      ? markets.reduce((s, m) => s + m.estimatedApyPct, 0) / markets.length
      : 0;

  return {
    tvl: tvl * 150, // Convert SOL to rough USD at $150
    totalOI,
    maxOI,
    avgApyPct: avgApy,
    oiUtilPct: maxOI > 0 ? (totalOI / maxOI) * 100 : 0,
    totalInsurance: totalInsurance * 150,
    markets,
    dailyFeeRevenue,
    avgApyAvailable: true, // mock mode only — the global mock banner labels these figures
  };
}

// ═══════════════════════════════════════════════════════════════
// Hook
// ═══════════════════════════════════════════════════════════════

export function useEarnStats() {
  const [stats, setStats] = useState<EarnStats>(DEFAULT_STATS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mockMode = isMockMode();

  const fetchStats = useCallback(async () => {
    if (mockMode) {
      setStats(generateMockStats());
      setLoading(false);
      return;
    }

    try {
      // Live data comes from the app's own APIs — NOT a direct browser
      // read of the Supabase markets_with_stats view. That view matches
      // zero rows for this deployment's markets from the browser's anon
      // client, and the previous implementation additionally required
      // status='active', which none of the serving rows carry — so /earn
      // rendered "No active vaults found" (and surfaced the failed view
      // read as a "Failed to fetch" toast) even with markets and stake
      // pools live on-chain.
      //   - /api/markets     → the market directory (symbol, name,
      //                        decimals, leverage/fee config, indexer
      //                        stats when the DB path serves them)
      //   - /api/stake/pools → the on-chain stake pools (vault balances,
      //                        trailing APR)
      // Every directory market gets a vault card; the pool join decides
      // whether deposits are actually possible (poolExists).
      const [marketsRes, poolsRes] = await Promise.all([
        fetch('/api/markets?include_zombie=true&limit=500', {
          headers: { Accept: 'application/json' },
        }),
        fetch('/api/stake/pools', {
          headers: { Accept: 'application/json' },
        }),
      ]);
      if (!marketsRes.ok) {
        throw new Error(`Markets API returned ${marketsRes.status}`);
      }
      if (!poolsRes.ok) {
        throw new Error(`Stake pools API returned ${poolsRes.status}`);
      }
      const marketsBody = (await marketsRes.json()) as {
        markets?: MarketsApiRow[];
      };
      const poolsBody = (await poolsRes.json()) as {
        pools?: StakePoolsApiRow[];
      };
      if (!Array.isArray(marketsBody.markets) || !Array.isArray(poolsBody.pools)) {
        throw new Error('Unexpected response from markets/pools APIs');
      }

      const poolBySlab = new Map(
        poolsBody.pools.map((p) => [p.slabAddress, p] as const),
      );

      const markets: MarketVaultInfo[] = marketsBody.markets
        // Skip blocked slabs (the API already excludes them; defense in depth).
        .filter((m) => !!m.slab_address && !isBlockedSlab(m.slab_address as string))
        .map((m) => {
          const slabAddress = m.slab_address as string;
          const pool = poolBySlab.get(slabAddress);
          const oiLongRaw = numOr(m.open_interest_long, 0);
          const oiShortRaw = numOr(m.open_interest_short, 0);
          const totalOIRaw = numOr(
            m.total_open_interest,
            oiLongRaw + oiShortRaw,
          );
          // Sentinel filter: u64::MAX (≈1.84e19) leaks from uninitialized on-chain fields.
          // Any value above 1e18 is garbage — treat as 0.
          const isSentinel = (v: number) => v > 1e18;
          const collDecimals = numOr(m.decimals, 6);
          const collDivisor = 10 ** collDecimals;
          // OI values are stored in collateral micro-units — convert to human units
          const totalOI = isSentinel(totalOIRaw) ? 0 : totalOIRaw / collDivisor;
          const maxLeverage = numOr(m.max_leverage, 0);
          // Vault balance = the stake pool's actual on-chain vault balance.
          // /api/stake/pools' tvlRaw is the raw SPL amount sitting in the
          // pool vault (base units) — the real deposit total, read from the
          // chain by the server. (The stats view's vault_balance described
          // the trading vault, not the Earn stake pool, and reads zero rows
          // in this deployment anyway.)
          const vaultBalanceRaw = pool ? Number(pool.tvlRaw ?? 0) : 0;
          // Two-stage filter for vault_balance:
          // 1. Sentinel guard: u64::MAX (>1e18) leaks from uninitialized on-chain fields.
          // 2. USD cap: compute human-readable amount and reject if > $10M per vault.
          //    Without this, a corrupt value at 6 decimals could produce wildly inflated TVL.
          const MAX_VAULT_USD = 10_000_000; // $10M per vault — generous devnet ceiling
          const vaultBalanceHuman = isSentinel(vaultBalanceRaw) ? Infinity : vaultBalanceRaw / collDivisor;
          const vaultBalance = vaultBalanceHuman > MAX_VAULT_USD ? 0 : vaultBalanceRaw;
          const tradingFeeBpsRaw = numOr(m.trading_fee_bps, 0);
          const tradingFeeBps = tradingFeeBpsRaw > 5_000 ? 0 : tradingFeeBpsRaw;
          const volume24hRaw = numOr(m.volume_24h, 0);
          // Normalize to human-readable collateral units (same as totalOI).
          const volume24h = isSentinel(volume24hRaw) ? 0 : volume24hRaw / collDivisor;
          const insuranceRaw = numOr(m.insurance_fund, 0);
          // Sanity cap: insurance_fund values > 10 billion USDC micro-units ($10M)
          // are corrupt data from bad slab tier detection — clamp to 0
          const insurance = insuranceRaw < 1e13 ? insuranceRaw : 0;

          // Max OI = vault collateral × max leverage (simplified)
          const vaultUsd = vaultBalance / collDivisor;
          const rawMaxOI = vaultUsd * maxLeverage;
          // On devnet, vault deposits can be tiny while accumulated OI is large.
          // Clamp displayMaxOI so it is never less than totalOI — prevents confusing
          // "Max: $343" display when Current OI is already $57K.
          const maxOI = Math.max(rawMaxOI, totalOI);
          const oiUtilPct = maxOI > 0 ? (totalOI / maxOI) * 100 : 0;

          // APY: the pools route's trailing APR (insurance-snapshot
          // redemption-rate growth). 0 when no snapshot history exists;
          // the header only presents an APY figure when avgApyAvailable
          // (at least one vault actually holds deposits).
          const estimatedApyPct = pool?.apr ?? 0;

          return {
            slabAddress,
            symbol: m.symbol ?? 'UNKNOWN',
            name: m.name ?? m.symbol ?? 'Unknown',
            poolExists: !!pool,
            vaultBalance,
            totalOI,
            maxOI,
            insuranceFund: insurance,
            volume24h,
            tradingFeeBps,
            maxLeverage,
            estimatedApyPct: Math.min(estimatedApyPct, 999), // cap display
            oiUtilPct: Math.min(oiUtilPct, 100),
            decimals: collDecimals,
          };
        });

      const tvl = markets.reduce((s, m) => s + m.vaultBalance / (10 ** m.decimals), 0);
      const totalOI = markets.reduce((s, m) => s + m.totalOI, 0);
      const maxOI = markets.reduce((s, m) => s + m.maxOI, 0);
      const totalInsurance = markets.reduce(
        (s, m) => s + m.insuranceFund / (10 ** m.decimals),
        0,
      );
      const dailyFeeRevenue = markets.reduce(
        (s, m) => s + (m.volume24h * m.tradingFeeBps) / 10_000,
        0,
      );
      const avgApy =
        markets.length > 0
          ? markets.reduce((s, m) => s + m.estimatedApyPct, 0) / markets.length
          : 0;

      setStats({
        tvl,
        totalOI,
        maxOI,
        avgApyPct: avgApy,
        oiUtilPct: maxOI > 0 ? (totalOI / maxOI) * 100 : 0,
        totalInsurance,
        markets,
        dailyFeeRevenue,
        // APY is only meaningful when at least one vault actually holds
        // deposits; with zero TVL the estimate is undefined, not 0%.
        avgApyAvailable: markets.some((m) => m.vaultBalance > 0),
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load earn stats');
      // On error show the true empty state — never mock figures as live.
      setStats(DEFAULT_STATS);
    } finally {
      setLoading(false);
    }
  }, [mockMode]);

  // Auto-refresh using ref
  const fetchRef = useRef(fetchStats);
  useEffect(() => {
    fetchRef.current = fetchStats;
  }, [fetchStats]);

  useEffect(() => {
    const doFetch = () => fetchRef.current();
    doFetch();
    const interval = setInterval(doFetch, 15_000);
    return () => clearInterval(interval);
  }, []);

  return { stats, loading, error, refresh: fetchStats };
}
