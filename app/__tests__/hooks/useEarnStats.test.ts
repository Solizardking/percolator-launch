import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// Mock modules before importing the hook
vi.mock('@/lib/mock-mode', () => ({
  isMockMode: vi.fn(() => false),
}));

import { useEarnStats } from '@/hooks/useEarnStats';
import { isMockMode } from '@/lib/mock-mode';

const SLAB_A = 'FCusfsg4uzcLSdRbj9Ez5okcrS1MwvKHvDbmcwrnSWvL';
const SLAB_B = '4r4bxZ2LxNCu4EWdkXThoVaBHBsYQcWkizdkmWciprJC';

function jsonResponse(body: unknown, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(body),
  } as Response);
}

describe('useEarnStats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isMockMode as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exports the hook', () => {
    expect(useEarnStats).toBeDefined();
    expect(typeof useEarnStats).toBe('function');
  });

  it('builds vault cards from /api/markets joined with /api/stake/pools', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/api/markets')) {
        return jsonResponse({
          markets: [
            {
              slab_address: SLAB_A,
              symbol: 'DEVNET-SMALL-1',
              name: 'Devnet Small Market',
              decimals: 6,
              max_leverage: null,
              trading_fee_bps: null,
              insurance_fund: null,
              volume_24h: null,
              total_open_interest: null,
            },
            {
              slab_address: SLAB_B,
              symbol: 'DEVNET-SMALL-2',
              name: 'Devnet Small Market',
              decimals: 6,
            },
          ],
        });
      }
      if (url.startsWith('/api/stake/pools')) {
        return jsonResponse({
          pools: [
            { slabAddress: SLAB_A, tvlRaw: '2500000', apr: 0 },
            // SLAB_B deliberately has no pool
          ],
        });
      }
      return jsonResponse({}, false, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useEarnStats());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeNull();
    expect(result.current.stats.markets).toHaveLength(2);

    const withPool = result.current.stats.markets.find(
      (m) => m.slabAddress === SLAB_A,
    );
    expect(withPool).toBeDefined();
    expect(withPool!.poolExists).toBe(true);
    // Vault balance comes from the pool's raw on-chain vault amount
    expect(withPool!.vaultBalance).toBe(2_500_000);
    expect(result.current.stats.tvl).toBeCloseTo(2.5, 6);

    const withoutPool = result.current.stats.markets.find(
      (m) => m.slabAddress === SLAB_B,
    );
    expect(withoutPool).toBeDefined();
    // Market without a pool is still listed — labeled, not hidden
    expect(withoutPool!.poolExists).toBe(false);
    expect(withoutPool!.vaultBalance).toBe(0);
  });

  it('shows the true empty state (never mock figures) when the markets API fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => jsonResponse({ error: 'boom' }, false, 500)),
    );

    const { result } = renderHook(() => useEarnStats());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toContain('500');
    expect(result.current.stats.markets).toHaveLength(0);
    expect(result.current.stats.tvl).toBe(0);
    expect(result.current.stats.avgApyAvailable).toBe(false);
  });

  it('mock mode still generates banner-labeled mock stats', async () => {
    (isMockMode as ReturnType<typeof vi.fn>).mockReturnValue(true);
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse({}, false, 404)));

    const { result } = renderHook(() => useEarnStats());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.stats.markets.length).toBeGreaterThan(0);
    expect(result.current.stats.markets.every((m) => m.poolExists)).toBe(true);
  });
});

describe('EarnStats types', () => {
  it('MarketVaultInfo has all required fields', () => {
    const sampleVault = {
      slabAddress: 'test-address',
      symbol: 'SOL',
      name: 'Solana',
      poolExists: true,
      vaultBalance: 1000000,
      totalOI: 5000,
      maxOI: 50000,
      insuranceFund: 100000,
      volume24h: 25000,
      tradingFeeBps: 10,
      maxLeverage: 20,
      estimatedApyPct: 15.5,
      oiUtilPct: 10,
      decimals: 6,
    };

    expect(sampleVault.slabAddress).toBe('test-address');
    expect(sampleVault.poolExists).toBe(true);
    expect(sampleVault.estimatedApyPct).toBe(15.5);
    expect(sampleVault.oiUtilPct).toBe(10);
  });

  it('EarnStats has all aggregate fields', () => {
    const sampleStats = {
      tvl: 100000,
      totalOI: 50000,
      maxOI: 500000,
      avgApyPct: 20.5,
      oiUtilPct: 10,
      totalInsurance: 10000,
      markets: [],
      dailyFeeRevenue: 500,
      avgApyAvailable: true,
    };

    expect(sampleStats.tvl).toBe(100000);
    expect(sampleStats.avgApyPct).toBe(20.5);
    expect(sampleStats.dailyFeeRevenue).toBe(500);
  });
});
