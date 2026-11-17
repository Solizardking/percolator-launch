/**
 * StakePool account decoding — version-tolerant local replacement for the
 * pinned SDK's `decodeStakePool` / `STAKE_POOL_SIZE`.
 *
 * Why this exists: the pinned `@percolatorct/sdk` (#1a174d3, v3.0.0) hardcodes
 * STAKE_POOL_SIZE = 384 (the v2 layout) and its decodeStakePool throws
 * "StakePool data too short: 352 < 384" on the live pools. The stake program
 * actually deployed on devnet (6aJb1F9C…) still creates **v1 pools of 352
 * bytes**, so every Earn-path consumer of the SDK decode rejected real,
 * initialized pools as "not initialized".
 *
 * Layout (percolator-stake, repr(C) Pod) — the first 288 bytes are
 * byte-identical across versions and contain every semantic field:
 *
 *     0  is_initialized   u8
 *     1  bump             u8
 *     2  vault_auth_bump  u8
 *     3  admin_transferred u8
 *     4..8    _padding
 *     8..40   slab            [u8; 32]
 *    40..72   admin           [u8; 32]
 *    72..104  collateral_mint [u8; 32]
 *   104..136  lp_mint         [u8; 32]
 *   136..168  vault           [u8; 32]
 *   168  total_deposited     u64
 *   176  total_lp_supply     u64
 *   184  cooldown_slots      u64
 *   192  deposit_cap         u64
 *   200  total_flushed       u64
 *   208  total_returned      u64
 *   216  total_withdrawn     u64
 *   224..256 percolator_program [u8; 32]
 *   256  total_fees_earned   u64
 *   264  last_fee_accrual_slot u64
 *   272  last_vault_snapshot u64
 *   280  pool_mode           u8
 *   281..288 _padding
 *
 * Version difference is confined to the tail after offset 288:
 *   - v1 (352 bytes total): a 64-byte tail block at 288..352.
 *   - v2 (384 bytes total): pending_admin [u8; 32] at 288..320, then the
 *     same 64-byte tail block at 320..384.
 * The tail block carries the HWM / tranche sub-fields at tail-relative
 * offsets (+9 market_resolved, +10 hwm_enabled, +11 hwm_floor_bps,
 * +16 epoch_high_water_tvl, +24 hwm_last_epoch, +32 tranche_enabled,
 * +33 junior_balance, +41 junior_total_lp, +49 junior_fee_mult_bps).
 * This decoder reads the tail from the version-appropriate base
 * (288 for v1, 320 for v2); all tail reads stay in bounds for both
 * (max end = base + 51 ≤ 352 for v1).
 *
 * Verified against the live devnet v1 pools on 2026-11-17: at these
 * offsets the 352-byte accounts decode to the correct slab (matching the
 * pool PDA derivation), admin, collateral/LP mints and vault, and every
 * byte at 288..352 is zero on all live pools, so the tail interpretation
 * does not affect any live value.
 *
 * The SDK pin is external (not vendored), so the fix lives here rather
 * than in a fork. If the SDK pin is ever bumped to a version whose
 * decode accepts v1 sizes, this module can be retired.
 */

import { PublicKey } from '@solana/web3.js';

/** On-chain size of a v1 StakePool account (stake program as deployed on devnet). */
export const STAKE_POOL_SIZE_V1 = 352;

/** On-chain size of a v2 StakePool account (adds pending_admin at offset 288). */
export const STAKE_POOL_SIZE_V2 = 384;

/**
 * Minimum account length accepted as a StakePool. Pre-flight checks and
 * decoders must use this — not the v2 size — so live v1 pools pass.
 */
export const STAKE_POOL_MIN_SIZE = STAKE_POOL_SIZE_V1;

/** Offset where the version-dependent tail begins (end of the shared prefix). */
const SHARED_PREFIX_SIZE = 288;

// ── Browser-safe little-endian readers (DataView; Buffer BigInt methods
// are Node-only and the browser polyfill may lack them) ─────────────────

function readU64LE(bytes: Uint8Array, off: number): bigint {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getBigUint64(off, /* littleEndian= */ true);
}

function readU16LE(bytes: Uint8Array, off: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint16(off, /* littleEndian= */ true);
}

// ── Decoded shape (mirrors the SDK's decodeStakePool return) ────────────

export interface StakePoolData {
  isInitialized: boolean;
  bump: number;
  vaultAuthorityBump: number;
  adminTransferred: boolean;
  marketResolved: boolean;
  slab: PublicKey;
  admin: PublicKey;
  collateralMint: PublicKey;
  lpMint: PublicKey;
  vault: PublicKey;
  totalDeposited: bigint;
  totalLpSupply: bigint;
  cooldownSlots: bigint;
  depositCap: bigint;
  totalFlushed: bigint;
  totalReturned: bigint;
  totalWithdrawn: bigint;
  percolatorProgram: PublicKey;
  /** v2 only; null for v1 pools (no pending_admin field) and when zeroed. */
  pendingAdmin: PublicKey | null;
  totalFeesEarned: bigint;
  lastFeeAccrualSlot: bigint;
  lastVaultSnapshot: bigint;
  poolMode: number;
  hwmEnabled: boolean;
  epochHighWaterTvl: bigint;
  hwmFloorBps: number;
  hwmLastEpoch: bigint;
  trancheEnabled: boolean;
  juniorBalance: bigint;
  juniorTotalLp: bigint;
  juniorFeeMultBps: number;
}

/**
 * Decode a StakePool account, accepting both the v1 (352-byte) and v2
 * (384-byte) layouts. Throws when the account is shorter than the v1
 * layout — i.e. it is not a stake pool account at all.
 */
export function decodeStakePool(data: Uint8Array): StakePoolData {
  if (data.length < STAKE_POOL_MIN_SIZE) {
    throw new Error(
      `StakePool data too short: ${data.length} < ${STAKE_POOL_MIN_SIZE} (v1 stake pools are ${STAKE_POOL_SIZE_V1} bytes)`,
    );
  }
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const isV2 = data.length >= STAKE_POOL_SIZE_V2;

  // Shared 288-byte prefix — identical offsets in v1 and v2.
  let off = 0;
  const isInitialized = bytes[off] === 1; off += 1;
  const bump = bytes[off]; off += 1;
  const vaultAuthorityBump = bytes[off]; off += 1;
  const adminTransferred = bytes[off] === 1; off += 1;
  off += 4; // padding
  const slab = new PublicKey(bytes.subarray(off, off + 32)); off += 32;
  const admin = new PublicKey(bytes.subarray(off, off + 32)); off += 32;
  const collateralMint = new PublicKey(bytes.subarray(off, off + 32)); off += 32;
  const lpMint = new PublicKey(bytes.subarray(off, off + 32)); off += 32;
  const vault = new PublicKey(bytes.subarray(off, off + 32)); off += 32;
  const totalDeposited = readU64LE(bytes, off); off += 8;
  const totalLpSupply = readU64LE(bytes, off); off += 8;
  const cooldownSlots = readU64LE(bytes, off); off += 8;
  const depositCap = readU64LE(bytes, off); off += 8;
  const totalFlushed = readU64LE(bytes, off); off += 8;
  const totalReturned = readU64LE(bytes, off); off += 8;
  const totalWithdrawn = readU64LE(bytes, off); off += 8;
  const percolatorProgram = new PublicKey(bytes.subarray(off, off + 32)); off += 32;
  const totalFeesEarned = readU64LE(bytes, off); off += 8;
  const lastFeeAccrualSlot = readU64LE(bytes, off); off += 8;
  const lastVaultSnapshot = readU64LE(bytes, off); off += 8;
  const poolMode = bytes[off]; off += 1;
  off += 7; // padding — off === SHARED_PREFIX_SIZE (288) here

  // Version-dependent tail.
  let pendingAdmin: PublicKey | null = null;
  let tailStart = SHARED_PREFIX_SIZE;
  if (isV2) {
    const pendingAdminBytes = bytes.subarray(off, off + 32);
    pendingAdmin = pendingAdminBytes.every((b) => b === 0)
      ? null
      : new PublicKey(pendingAdminBytes);
    tailStart = off + 32;
  }

  const marketResolved = bytes[tailStart + 9] === 1;
  const hwmEnabled = bytes[tailStart + 10] === 1;
  const hwmFloorBps = readU16LE(bytes, tailStart + 11);
  const epochHighWaterTvl = readU64LE(bytes, tailStart + 16);
  const hwmLastEpoch = readU64LE(bytes, tailStart + 24);
  const trancheEnabled = bytes[tailStart + 32] === 1;
  const juniorBalance = readU64LE(bytes, tailStart + 33);
  const juniorTotalLp = readU64LE(bytes, tailStart + 41);
  const juniorFeeMultBps = readU16LE(bytes, tailStart + 49);

  return {
    isInitialized,
    bump,
    vaultAuthorityBump,
    adminTransferred,
    marketResolved,
    slab,
    admin,
    collateralMint,
    lpMint,
    vault,
    totalDeposited,
    totalLpSupply,
    cooldownSlots,
    depositCap,
    totalFlushed,
    totalReturned,
    totalWithdrawn,
    percolatorProgram,
    pendingAdmin,
    totalFeesEarned,
    lastFeeAccrualSlot,
    lastVaultSnapshot,
    poolMode,
    hwmEnabled,
    epochHighWaterTvl,
    hwmFloorBps,
    hwmLastEpoch,
    trancheEnabled,
    juniorBalance,
    juniorTotalLp,
    juniorFeeMultBps,
  };
}
