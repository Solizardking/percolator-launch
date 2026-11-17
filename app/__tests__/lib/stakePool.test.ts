/**
 * lib/stakePool — version-tolerant StakePool decoder tests.
 *
 * The fixture below is a REAL v1 pool account captured from devnet on
 * 2026-11-17 (pool 4Ls9L7Fi1DgcRN32wo5K2Y87874uscbo2ZkHkqNNxJcS for slab
 * 4r4bxZ2LxNCu4EWdkXThoVaBHBsYQcWkizdkmWciprJC, owned by stake program
 * 6aJb1F9CDCVWCNYFwj8aQsVb696YnW6J1FznteHq4Q6k, 352 bytes). The pinned
 * SDK's decodeStakePool throws on this exact account
 * ("StakePool data too short: 352 < 384"); the local decoder must not.
 */

import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  decodeStakePool,
  STAKE_POOL_MIN_SIZE,
  STAKE_POOL_SIZE_V1,
  STAKE_POOL_SIZE_V2,
} from '@/lib/stakePool';

const REAL_V1_POOL_BASE64 =
  'Af//AAAAAAA5JJgSinl7zsveJuReuoaFr1lm+ph/PmzN9z68+qtT0ZbSl+IqM/cK/1su4Ny7W4HMHE+EQkwNZ2+zEU7wd+1Gvoy1n1zof8aQutb9DHqoomWHUo+A7bVRxby7cOyc9D4jwMYZjpfOfc9/mXLlpsbOy3cSXrbdCNzya74KH4QPn1rhEbMJIDlCvKAwkuKSpcCP3GZbnaF0A80YkKU80ej2AAAAAAAAAAAAAAAAAAAAACwBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADeBCYJkYaGYsYzHqFxBKF0duLzpScXxTBf/T1OahvL7wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

describe('stakePool size constants', () => {
  it('exposes the real v1/v2 sizes', () => {
    expect(STAKE_POOL_SIZE_V1).toBe(352);
    expect(STAKE_POOL_SIZE_V2).toBe(384);
    expect(STAKE_POOL_MIN_SIZE).toBe(352);
  });
});

describe('decodeStakePool — real v1 pool (352 bytes)', () => {
  const data = Buffer.from(REAL_V1_POOL_BASE64, 'base64');

  it('fixture is the real 352-byte account', () => {
    expect(data.length).toBe(352);
  });

  it('decodes every core field at the on-chain offsets', () => {
    const pool = decodeStakePool(data);
    expect(pool.isInitialized).toBe(true);
    expect(pool.bump).toBe(255);
    expect(pool.vaultAuthorityBump).toBe(255);
    expect(pool.adminTransferred).toBe(false);
    expect(pool.slab.toBase58()).toBe('4r4bxZ2LxNCu4EWdkXThoVaBHBsYQcWkizdkmWciprJC');
    expect(pool.admin.toBase58()).toBe('B9kQTYREkLVXKtyipSXhZPPmChZXMrPq5NR5RjKnNyxR');
    expect(pool.collateralMint.toBase58()).toBe('DppubGGFx9iCN7Ui2GRAckbR1xUatgeTe14B8SiRFrwF');
    expect(pool.lpMint.toBase58()).toBe('3QZm4CbNzBxNmr219ySeYnarXPCa5GMNAVRA1QsfFbdY');
    expect(pool.vault.toBase58()).toBe('77kkDU4xbsqaXkiFJYhoWLi6RZAKUcyFVMrCi8ViyZZf');
    expect(pool.totalDeposited).toBe(0n);
    expect(pool.totalLpSupply).toBe(0n);
    expect(pool.cooldownSlots).toBe(300n);
    expect(pool.depositCap).toBe(0n);
    expect(pool.percolatorProgram.toBase58()).toBe('FwfBKZXbYr4vTK23bMFkbgKq3npJ3MSDxEaKmq9Aj4Qn');
    expect(pool.totalFeesEarned).toBe(0n);
    expect(pool.poolMode).toBe(0);
  });

  it('reports pendingAdmin=null and a zeroed tail for v1', () => {
    const pool = decodeStakePool(data);
    expect(pool.pendingAdmin).toBeNull();
    expect(pool.marketResolved).toBe(false);
    expect(pool.hwmEnabled).toBe(false);
    expect(pool.trancheEnabled).toBe(false);
    expect(pool.juniorBalance).toBe(0n);
  });
});

describe('decodeStakePool — v2 pool (384 bytes)', () => {
  function buildV2Pool(): Buffer {
    const buf = Buffer.alloc(384);
    buf[0] = 1;
    buf[1] = 254;
    buf[2] = 253;
    const slab = new PublicKey('4r4bxZ2LxNCu4EWdkXThoVaBHBsYQcWkizdkmWciprJC');
    const lpMint = new PublicKey('3QZm4CbNzBxNmr219ySeYnarXPCa5GMNAVRA1QsfFbdY');
    const vault = new PublicKey('77kkDU4xbsqaXkiFJYhoWLi6RZAKUcyFVMrCi8ViyZZf');
    const pending = new PublicKey('B9kQTYREkLVXKtyipSXhZPPmChZXMrPq5NR5RjKnNyxR');
    slab.toBuffer().copy(buf, 8);
    lpMint.toBuffer().copy(buf, 104);
    vault.toBuffer().copy(buf, 136);
    buf.writeBigUInt64LE(123_456n, 168); // total_deposited
    buf.writeBigUInt64LE(600n, 184); // cooldown_slots
    pending.toBuffer().copy(buf, 288); // pending_admin (v2 only)
    buf[320 + 32] = 1; // tranche_enabled in the v2 tail block
    buf.writeBigUInt64LE(777n, 320 + 33); // junior_balance
    return buf;
  }

  it('still decodes, including pending_admin and the shifted tail', () => {
    const pool = decodeStakePool(buildV2Pool());
    expect(pool.isInitialized).toBe(true);
    expect(pool.lpMint.toBase58()).toBe('3QZm4CbNzBxNmr219ySeYnarXPCa5GMNAVRA1QsfFbdY');
    expect(pool.vault.toBase58()).toBe('77kkDU4xbsqaXkiFJYhoWLi6RZAKUcyFVMrCi8ViyZZf');
    expect(pool.totalDeposited).toBe(123_456n);
    expect(pool.cooldownSlots).toBe(600n);
    expect(pool.pendingAdmin?.toBase58()).toBe('B9kQTYREkLVXKtyipSXhZPPmChZXMrPq5NR5RjKnNyxR');
    expect(pool.trancheEnabled).toBe(true);
    expect(pool.juniorBalance).toBe(777n);
  });

  it('treats a zeroed v2 pending_admin as null', () => {
    const buf = buildV2Pool();
    buf.fill(0, 288, 320);
    expect(decodeStakePool(buf).pendingAdmin).toBeNull();
  });
});

describe('decodeStakePool — not a pool', () => {
  it('throws below the v1 size (e.g. a 152-byte DepositPda)', () => {
    expect(() => decodeStakePool(Buffer.alloc(152))).toThrow(/too short: 152 < 352/);
    expect(() => decodeStakePool(Buffer.alloc(351))).toThrow(/too short/);
    expect(() => decodeStakePool(Buffer.alloc(0))).toThrow(/too short/);
  });
});
