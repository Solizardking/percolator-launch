'use client';

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { PublicKey } from '@solana/web3.js';
import { useWalletCompat, useConnectionCompat } from '@/hooks/useWalletCompat';
import {
  deriveStakePool,
  deriveStakeVaultAuth,
  deriveDepositPda,
} from '@percolatorct/sdk';
import { decodeStakePool } from '@/lib/stakePool';
import { useSlabState } from '@/components/providers/SlabProvider';
import { useParams } from 'next/navigation';
import {
  getAssociatedTokenAddress,
  unpackMint,
  unpackAccount,
} from '@solana/spl-token';

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface StakePoolState {
  /** Whether the stake pool PDA exists on-chain */
  poolExists: boolean;
  /** Stake pool PDA */
  poolAddress: PublicKey | null;
  /** Vault authority PDA (signs transfers) */
  vaultAuthAddress: PublicKey | null;
  /** User deposit PDA (tracks cooldown) */
  depositPdaAddress: PublicKey | null;
  /** LP mint for this stake pool */
  lpMintAddress: PublicKey | null;
  /** Collateral vault balance (tokens in the stake vault) */
  vaultBalance: bigint;
  /** Total LP supply minted */
  lpSupply: bigint;
  /** User's LP token balance */
  userLpBalance: bigint;
  /** User's collateral ATA balance (available to deposit) */
  userCollateralBalance: bigint;
  /** Current redemption rate: vault_balance / lp_supply (scaled to 1e6) */
  redemptionRateE6: bigint;
  /** User's share of the pool as a percentage */
  userSharePct: number;
  /** User's redeemable collateral value */
  userRedeemableValue: bigint;
  /** Cooldown slots from pool config (0 = no cooldown) */
  cooldownSlots: bigint;
  /** Deposit cap from pool config (0 = unlimited) */
  depositCap: bigint;
  /** User's deposit timestamp slot (from deposit PDA, 0 if no deposit) */
  userDepositSlot: bigint;
  /** Whether user's cooldown has elapsed (can withdraw) */
  cooldownElapsed: boolean;
}

const DEFAULT_STATE: StakePoolState = {
  poolExists: false,
  poolAddress: null,
  vaultAuthAddress: null,
  depositPdaAddress: null,
  lpMintAddress: null,
  vaultBalance: 0n,
  lpSupply: 0n,
  userLpBalance: 0n,
  userCollateralBalance: 0n,
  redemptionRateE6: 1_000_000n,
  userSharePct: 0,
  userRedeemableValue: 0n,
  cooldownSlots: 0n,
  depositCap: 0n,
  userDepositSlot: 0n,
  cooldownElapsed: true,
};

// ═══════════════════════════════════════════════════════════════
// DepositPda account layout helper
// ═══════════════════════════════════════════════════════════════

// Browser-safe u64 reader — DataView instead of Buffer.readBigUInt64LE
// (Buffer BigInt methods are Node.js-only; the browser polyfill may lack them)
function readU64LE(data: Uint8Array, off: number): bigint {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigUint64(off, /* littleEndian= */ true);
}

/**
 * Parse the on-chain DepositPda (per-user) account.
 * Layout:
 *   - is_initialized: u8       (1 byte)
 *   - bump:           u8       (1 byte)
 *   - padding:        [u8; 6]  (6 bytes)
 *   - pool:           [u8; 32] (32 bytes)
 *   - user:           [u8; 32] (32 bytes)
 *   - deposit_slot:   u64      (8 bytes)
 *   - amount:         u64      (8 bytes)
 * Total: 88 bytes used out of the 152-byte on-chain account.
 */
function parseDepositPdaAccount(data: Buffer) {
  if (data.length < 88) return null;
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const isInitialized = bytes[0] === 1;
  if (!isInitialized) return null;

  let offset = 8; // skip is_initialized, bump, and padding
  const pool = new PublicKey(bytes.subarray(offset, offset + 32)); offset += 32;
  const user = new PublicKey(bytes.subarray(offset, offset + 32)); offset += 32;
  const depositSlot = readU64LE(bytes, offset); offset += 8;
  const amount = readU64LE(bytes, offset); offset += 8;

  return { pool, user, depositSlot, amount };
}

// ═══════════════════════════════════════════════════════════════
// Server pools fallback
// ═══════════════════════════════════════════════════════════════

/**
 * Shape of one entry in GET /api/stake/pools (only the fields this hook
 * consumes). The route reads the pools directly on-chain server-side, so
 * a record here is chain truth — the same data the /earn list renders.
 */
interface ServerPoolRecord {
  poolAddress: string;
  slabAddress: string;
  lpMint: string;
  /** Vault balance in raw token units (stringified bigint) */
  tvlRaw: string;
  /** Total LP supply in raw units (JSON number; exact for values < 2^53) */
  totalLpSupply: number;
  cooldownSlots: number;
  /** Deposit cap in raw units, stringified (0 = uncapped) */
  capTotalRaw: string;
}

const SERVER_POOLS_TTL_MS = 15_000;
let serverPoolsCache: {
  fetchedAt: number;
  bySlab: Map<string, ServerPoolRecord>;
} | null = null;
let serverPoolsInflight: Promise<Map<string, ServerPoolRecord>> | null = null;

/**
 * Fetch the server-side pools directory, shared across hook instances
 * and cached briefly. Any failure resolves to an empty map — callers
 * treat "no record" as "fall through to the RPC verdict", never as
 * proof a pool does not exist.
 */
async function fetchServerPoolsBySlab(): Promise<Map<string, ServerPoolRecord>> {
  const now = Date.now();
  if (
    serverPoolsCache &&
    now - serverPoolsCache.fetchedAt < SERVER_POOLS_TTL_MS
  ) {
    return serverPoolsCache.bySlab;
  }
  if (serverPoolsInflight) return serverPoolsInflight;

  serverPoolsInflight = (async () => {
    const empty = new Map<string, ServerPoolRecord>();
    try {
      if (typeof fetch !== "function") return empty;
      const res = await fetch("/api/stake/pools", {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return empty;
      const body: unknown = await res.json();
      const pools = (body as { pools?: unknown })?.pools;
      if (!Array.isArray(pools)) return empty;
      const bySlab = new Map<string, ServerPoolRecord>();
      for (const p of pools) {
        const rec = p as ServerPoolRecord;
        if (rec && typeof rec.slabAddress === "string") {
          bySlab.set(rec.slabAddress, rec);
        }
      }
      serverPoolsCache = { fetchedAt: Date.now(), bySlab };
      return bySlab;
    } catch {
      return empty;
    } finally {
      serverPoolsInflight = null;
    }
  })();
  return serverPoolsInflight;
}

// ═══════════════════════════════════════════════════════════════
// Hook
// ═══════════════════════════════════════════════════════════════

/**
 * Read-only hook for stake pool state. Derives PDAs, fetches on-chain data,
 * and returns balances, redemption rate, cooldown status, etc.
 *
 * Auto-refreshes every 10s. Call `refreshState()` for manual refresh.
 */
export function useStakePool() {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const slabState = useSlabState();
  const params = useParams();
  const slabAddress = params?.slab as string | undefined;

  const [state, setState] = useState<StakePoolState>(DEFAULT_STATE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stabilize wallet ref
  const walletPubkeyStr = wallet.publicKey?.toBase58() ?? null;

  // Derive PDAs
  const pdas = useMemo(() => {
    if (!slabAddress) return null;
    try {
      const slabPk = new PublicKey(slabAddress);
      const [poolPda] = deriveStakePool(slabPk);
      const [vaultAuthPda] = deriveStakeVaultAuth(poolPda);
      let depositPda: PublicKey | null = null;
      if (walletPubkeyStr) {
        const walletPk = new PublicKey(walletPubkeyStr);
        [depositPda] = deriveDepositPda(poolPda, walletPk);
      }
      return { poolPda, vaultAuthPda, depositPda, slabPk };
    } catch {
      return null;
    }
  }, [slabAddress, walletPubkeyStr]);

  /**
   * Fallback for when the browser RPC path cannot see the pool (proxy
   * rejection, endpoint outage): the server's /api/stake/pools route
   * reads the same accounts on-chain, so its record is authoritative
   * for pool-level state. Without this, any RPC failure was swallowed
   * into poolExists=false and the vault page claimed initialized pools
   * were "Not Initialized". User-specific balances still come from the
   * RPC path; when it is down they read 0 here, which is the truth the
   * UI can act on (the deposit action itself needs the RPC anyway).
   * Returns true when a server record was applied.
   */
  const applyServerPoolFallback = useCallback(async (): Promise<boolean> => {
    if (!slabAddress || !pdas) return false;
    try {
      const bySlab = await fetchServerPoolsBySlab();
      const rec = bySlab.get(slabAddress);
      if (!rec) return false;

      let vaultBalance = 0n;
      let depositCap = 0n;
      try { vaultBalance = BigInt(rec.tvlRaw || "0"); } catch { /* keep 0 */ }
      try { depositCap = BigInt(rec.capTotalRaw || "0"); } catch { /* keep 0 */ }
      const lpSupply = BigInt(Math.max(0, Math.trunc(rec.totalLpSupply || 0)));
      const redemptionRateE6 = lpSupply > 0n
        ? (vaultBalance * 1_000_000n) / lpSupply
        : 1_000_000n;

      let lpMintAddress: PublicKey | null = null;
      let poolAddress: PublicKey | null = pdas.poolPda;
      try { lpMintAddress = new PublicKey(rec.lpMint); } catch { /* keep null */ }
      try { poolAddress = new PublicKey(rec.poolAddress); } catch { /* keep derived */ }

      setState({
        ...DEFAULT_STATE,
        poolExists: true,
        poolAddress,
        vaultAuthAddress: pdas.vaultAuthPda,
        depositPdaAddress: pdas.depositPda,
        lpMintAddress,
        vaultBalance,
        lpSupply,
        redemptionRateE6,
        cooldownSlots: BigInt(Math.max(0, Math.trunc(rec.cooldownSlots || 0))),
        depositCap,
        cooldownElapsed: true,
      });
      return true;
    } catch {
      return false;
    }
  }, [slabAddress, pdas]);

  const refreshState = useCallback(async () => {
    if (!pdas || !connection) return;

    try {
      // Fetch pool account
      const poolInfo = await connection.getAccountInfo(pdas.poolPda);
      if (!poolInfo || poolInfo.data.length === 0) {
        if (await applyServerPoolFallback()) return;
        setState({ ...DEFAULT_STATE, poolAddress: pdas.poolPda, vaultAuthAddress: pdas.vaultAuthPda });
        return;
      }

      // Decode pool with the version-tolerant local decoder (v1 352-byte
      // and v2 384-byte layouts) — see lib/stakePool.ts. The pinned SDK's
      // decodeStakePool throws on the live v1 pools, which used to make
      // this hook report poolExists=false for initialized pools.
      let poolData: ReturnType<typeof decodeStakePool> | null = null;
      try {
        poolData = decodeStakePool(Buffer.from(poolInfo.data));
        if (!poolData.isInitialized) poolData = null;
      } catch {
        poolData = null;
      }
      if (!poolData) {
        if (await applyServerPoolFallback()) return;
        setState({ ...DEFAULT_STATE, poolAddress: pdas.poolPda, vaultAuthAddress: pdas.vaultAuthPda });
        return;
      }

      // Fetch LP mint supply
      let lpSupply = 0n;
      try {
        const mintInfo = await connection.getAccountInfo(poolData.lpMint);
        if (mintInfo) {
          const mint = unpackMint(poolData.lpMint, mintInfo);
          lpSupply = mint.supply;
        }
      } catch { /* mint may not exist yet */ }

      // Fetch vault balance (collateral in stake vault)
      let vaultBalance = 0n;
      try {
        const vaultInfo = await connection.getAccountInfo(poolData.vault);
        if (vaultInfo) {
          const vaultAccount = unpackAccount(poolData.vault, vaultInfo);
          vaultBalance = vaultAccount.amount;
        }
      } catch { /* vault may not exist */ }

      // Fetch user balances
      let userLpBalance = 0n;
      let userCollateralBalance = 0n;
      let userDepositSlot = 0n;

      if (walletPubkeyStr && slabState.config) {
        const walletPk = new PublicKey(walletPubkeyStr);
        const collateralMint = slabState.config.collateralMint;

        // User LP ATA
        try {
          const userLpAta = await getAssociatedTokenAddress(poolData.lpMint, walletPk);
          const lpAtaInfo = await connection.getAccountInfo(userLpAta);
          if (lpAtaInfo) {
            const acct = unpackAccount(userLpAta, lpAtaInfo);
            userLpBalance = acct.amount;
          }
        } catch { /* no LP ATA yet */ }

        // User collateral ATA
        try {
          const userCollAta = await getAssociatedTokenAddress(collateralMint, walletPk);
          const collAtaInfo = await connection.getAccountInfo(userCollAta);
          if (collAtaInfo) {
            const acct = unpackAccount(userCollAta, collAtaInfo);
            userCollateralBalance = acct.amount;
          }
        } catch { /* no collateral ATA */ }

        // User deposit PDA (cooldown tracking)
        if (pdas.depositPda) {
          try {
            const depInfo = await connection.getAccountInfo(pdas.depositPda);
            if (depInfo) {
              const depData = parseDepositPdaAccount(Buffer.from(depInfo.data));
              if (depData) {
                userDepositSlot = depData.depositSlot;
              }
            }
          } catch { /* no deposit PDA yet */ }
        }
      }

      // Calculate derived values
      const redemptionRateE6 = lpSupply > 0n
        ? (vaultBalance * 1_000_000n) / lpSupply
        : 1_000_000n;

      const userSharePct = lpSupply > 0n
        ? Number((userLpBalance * 10000n) / lpSupply) / 100
        : 0;

      const userRedeemableValue = lpSupply > 0n
        ? (userLpBalance * vaultBalance) / lpSupply
        : 0n;

      // Cooldown check — compare current slot to deposit slot + cooldown
      let cooldownElapsed = true;
      if (userDepositSlot > 0n && poolData.cooldownSlots > 0n) {
        try {
          const currentSlot = BigInt(await connection.getSlot());
          cooldownElapsed = currentSlot >= userDepositSlot + poolData.cooldownSlots;
        } catch {
          cooldownElapsed = false; // conservative: block withdrawal if we can't check
        }
      }

      setState({
        poolExists: true,
        poolAddress: pdas.poolPda,
        vaultAuthAddress: pdas.vaultAuthPda,
        depositPdaAddress: pdas.depositPda,
        lpMintAddress: poolData.lpMint,
        vaultBalance,
        lpSupply,
        userLpBalance,
        userCollateralBalance,
        redemptionRateE6,
        userSharePct,
        userRedeemableValue,
        cooldownSlots: poolData.cooldownSlots,
        depositCap: poolData.depositCap,
        userDepositSlot,
        cooldownElapsed,
      });
    } catch (err) {
      // RPC path failed outright (e.g. the /api/rpc proxy rejected the
      // request) — try the server directory before reporting an error
      // state; a pool that exists on-chain must not render as missing.
      if (await applyServerPoolFallback()) {
        setError(null);
        return;
      }
      console.error('[useStakePool] Failed to refresh:', err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [pdas, connection, walletPubkeyStr, slabState.config, applyServerPoolFallback]);

  // Auto-refresh using ref to avoid stale closure (same pattern as useInsuranceLP)
  const refreshRef = useRef(refreshState);
  useEffect(() => {
    refreshRef.current = refreshState;
  }, [refreshState]);

  useEffect(() => {
    const doRefresh = () => refreshRef.current();
    doRefresh();
    const interval = setInterval(doRefresh, 10_000);
    return () => clearInterval(interval);
  }, []);

  return {
    state,
    loading,
    error,
    refreshState,
    pdas,
  };
}
