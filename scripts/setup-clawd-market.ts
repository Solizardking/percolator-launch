/**
 * Setup CLAWD Perp Market on Devnet
 *
 * Creates a coin-margined CLAWD perpetual futures market on devnet.
 * Since CLAWD has no DEX pool on devnet, uses admin oracle mode
 * where the deployer pushes prices directly.
 *
 * This is a CLAWD/USD perp — traders deposit CLAWD as collateral.
 *
 * Usage:
 *   npx tsx scripts/setup-clawd-market.ts
 *
 * Environment:
 *   RPC_URL — devnet RPC (defaults to Helius devnet)
 *   KEYPAIR_PATH — admin keypair path
 *   COLLATERAL_MINT — CLAWD token address on devnet
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
  ACCOUNT_SIZE as TOKEN_ACCOUNT_SIZE,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";

// Load env
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

import {
  encodeInitMarket,
  encodeSetDexPool,
  encodeInitLP,
  encodeInitMatcherCtx,
  encodeTopUpInsurance,
  SLAB_TIERS_V12_19,
} from "@percolatorct/sdk";
import {
  buildAccountMetas,
  ACCOUNTS_INIT_MARKET,
  ACCOUNTS_INIT_LP,
  ACCOUNTS_INIT_MATCHER_CTX,
  ACCOUNTS_TOPUP_INSURANCE,
} from "@percolatorct/sdk";

// ============================================================================
// Program IDs (devnet)
// ============================================================================

// Small tier program (256 accounts, ~0.44 SOL rent)
const PROGRAM_ID_DEVNET = new PublicKey(
  "FwfBKZXbYr4vTK23bMFkbgKq3npJ3MSDxEaKmq9Aj4Qn",
);
const MATCHER_PROG_ID = new PublicKey(
  "GTRgyTDfrMvBubALAqtHuQwT8tbGyXid7svXZKtWfC9k",
);
const STAKE_PROG_ID = new PublicKey(
  "DC5fovFQD5SZYsetwvEqd4Wi4PFY1Yfnc669VMe6oa7F",
);

// ============================================================================
// CLAWD token (devnet)
// ============================================================================

const CLAWD_DEVNET = new PublicKey(
  process.env.COLLATERAL_MINT || "9iJ61cm9abZWuLfoJyoNNzinvM1mP66L5CrzNtcK3qbh",
);

// ============================================================================
// Slab constants
// ============================================================================

const SLAB_DATA_SIZE = SLAB_TIERS_V12_19.small.dataSize;
const MATCHER_CTX_SIZE = 320;

// ============================================================================
// RiskParams defaults — CLAWD/USD perp (Admin oracle mode)
// ============================================================================

const DEFAULT_RISK_PARAMS = {
  hMin:                   150n,
  hMax:                   600n,
  maintenanceMarginBps:   500n,            // 5%
  initialMarginBps:       1000n,           // 10% = 10x max leverage
  tradingFeeBps:          10n,             // 0.1%
  maxAccounts:            256n,            // small tier
  newAccountFee:          1_000_000n,      // 1 CLAWD
  maintenanceFeePerSlot:  0n,
  maxCrankStalenessSlots: 300n,            // 5 minutes
  liquidationFeeBps:      50n,             // 0.5%
  liquidationFeeCap:      100_000_000n,    // 100 CLAWD
  minLiquidationAbs:      100n,
  minInitialDeposit:      2_000_000n,      // 2 CLAWD
  minNonzeroMmReq:        100_000n,        // 0.1 CLAWD
  minNonzeroImReq:        500_000n,        // 0.5 CLAWD
  insuranceFloor:         0n,
} as const;

const DEFAULT_INIT_EXTRA = {
  maxInsuranceFloor:        1_000_000_000_000n,
  minOraclePriceCap:        500n,          // 5% min price cap
} as const;

// Matcher defaults — passive vAMM
const DEFAULT_MATCHER_CTX = {
  lpIdx:                0,
  kind:                 0,
  tradingFeeBps:        30,       // 0.30%
  baseSpreadBps:        10,
  maxTotalBps:          200,
  impactKBps:           100,
  liquidityNotionalE6:  1_000_000_000n,          // $1,000 notional
  maxFillAbs:           100_000_000_000_000n,
  maxInventoryAbs:      10_000_000n,              // 10 CLAWD max inventory
  feeToInsuranceBps:    2000,
  skewSpreadMultBps:    5000,
} as const;

// ============================================================================
// CLI / env config
// ============================================================================

interface SetupConfig {
  rpcUrl: string;
  keypairPath: string;
  collateralMint: PublicKey;
  programId: PublicKey;
  initialMarkPriceE6: bigint;
  seedDepositAmount: bigint;
  insuranceAmount: bigint;
  slabSize: number;
}

function parseArgs(): SetupConfig {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx !== -1 ? argv[idx + 1] : undefined;
  };

  const rpcUrl = get("--rpc") ?? process.env.RPC_URL ?? "https://devnet.helius-rpc.com/?api-key=f1598ee2-cd64-4bad-881d-fce6e386665c";

  const keypairPath = get("--keypair") ?? process.env.KEYPAIR_PATH ?? path.join(
    process.env.HOME!,
    ".config",
    "solana",
    "id.json",
  );

  const collateralMintStr = get("--collateral-mint") ?? process.env.COLLATERAL_MINT;
  if (!collateralMintStr) {
    console.error("ERROR: CLAWD token address required via --collateral-mint or COLLATERAL_MINT env");
    process.exit(1);
  }
  const collateralMint = new PublicKey(collateralMintStr);

  const programId = PROGRAM_ID_DEVNET;

  // For admin oracle mode, we set a non-zero indexFeedId to tell the
  // program this is NOT Hyperp mode. The oracle authority defaults to
  // the admin who signs InitMarket, but can be transferred via SetOracleAuthority.
  // We use a dummy feed ID to activate admin oracle mode.
  const initialMarkPriceE6 = BigInt(
    get("--initial-price-e6") ?? process.env.INITIAL_PRICE_E6 ?? "1000000", // $1.00 default for devnet
  );

  const seedDepositAmount = BigInt(
    get("--seed-deposit") ?? process.env.SEED_DEPOSIT ?? "5000000000", // 5,000 CLAWD
  );

  const insuranceAmount = BigInt(
    get("--insurance") ?? process.env.INSURANCE_AMOUNT ?? "1000000000", // 1,000 CLAWD
  );

  return {
    rpcUrl,
    keypairPath,
    collateralMint,
    programId,
    initialMarkPriceE6,
    seedDepositAmount,
    insuranceAmount,
    slabSize: SLAB_DATA_SIZE,
  };
}

// ============================================================================
// Helpers
// ============================================================================

function redactRpcUrl(rpcUrl: string): string {
  return rpcUrl.replace(/([?&]api-key=)[^&]+/i, "$1<redacted>");
}

function loadKeypair(p: string): Keypair {
  const raw = fs.readFileSync(p, "utf8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

function saveKeypairBackup(name: string, kp: Keypair, dir: string): void {
  const filePath = path.join(dir, `${name}.json`);
  fs.writeFileSync(filePath, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  console.log(`  saved keypair: ${filePath} (pubkey ${kp.publicKey.toBase58()})`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAccountOwner(
  conn: Connection,
  address: PublicKey,
  owner: PublicKey,
  label: string,
  expectedLength?: number,
): Promise<void> {
  const deadline = Date.now() + 90_000;
  let lastState = "missing";

  while (Date.now() < deadline) {
    const info = await conn.getAccountInfo(address, "finalized");
    if (info) {
      lastState = `owner=${info.owner.toBase58()} len=${info.data.length}`;
      const ownerOk = info.owner.equals(owner);
      const lengthOk = expectedLength === undefined || info.data.length === expectedLength;
      if (ownerOk && lengthOk) {
        console.log(`  ${label} finalized: ${address.toBase58()} (${lastState})`);
        return;
      }
    }
    await sleep(1_500);
  }
  throw new Error(`${label} did not finalize with expected owner/size (${lastState})`);
}

async function sendTx(
  conn: Connection,
  tx: Transaction,
  signers: Keypair[],
  label: string,
): Promise<string> {
  const { blockhash, lastValidBlockHeight } =
    await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0].publicKey;

  const sim = await conn.simulateTransaction(tx, signers);
  console.log(`  ${label} simulation CU: ${sim.value.unitsConsumed ?? "unknown"}`);
  if (sim.value.err) {
    console.error(`  ${label} simulation failed:`, JSON.stringify(sim.value.err));
    for (const log of sim.value.logs ?? []) console.error(`    ${log}`);
    throw new Error(`${label} simulation failed`);
  }

  const sig = await sendAndConfirmTransaction(conn, tx, signers, {
    commitment: "confirmed",
    maxRetries: 3,
  });

  console.log(`  ${label}: https://solscan.io/tx/${sig}?cluster=devnet`);
  return sig;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const cfg = parseArgs();

  console.log("========== CLAWD Perp Market Setup (Devnet) ==========");
  console.log(`RPC:             ${redactRpcUrl(cfg.rpcUrl)}`);
  console.log(`Admin keypair:   ${cfg.keypairPath}`);
  console.log(`Program:         ${cfg.programId.toBase58()}`);
  console.log(`Collateral mint: ${cfg.collateralMint.toBase58()} (CLAWD)`);
  console.log(`Initial price:   $${(Number(cfg.initialMarkPriceE6) / 1_000_000).toFixed(6)}`);
  console.log(`Seed deposit:    ${Number(cfg.seedDepositAmount) / 1_000_000} CLAWD`);
  console.log(`Insurance seed:  ${Number(cfg.insuranceAmount) / 1_000_000} CLAWD`);
  console.log(`Oracle mode:     admin (no DEX pool required — deployer pushes prices)`);
  console.log("=======================================================\n");

  const conn = new Connection(cfg.rpcUrl, "confirmed");
  const admin = loadKeypair(cfg.keypairPath);
  console.log(`Admin public key: ${admin.publicKey.toBase58()}`);

  // Pre-flight checks
  const adminSol = await conn.getBalance(admin.publicKey);
  console.log(`Admin SOL:        ${(adminSol / 1e9).toFixed(4)} SOL`);

  const adminAta = await getAssociatedTokenAddress(
    cfg.collateralMint,
    admin.publicKey,
  );
  const adminAtaInfo = await conn.getAccountInfo(adminAta);
  const adminBalance = adminAtaInfo
    ? Number(Buffer.from(adminAtaInfo.data).readBigUInt64LE(64)) / 1e6
    : 0;
  console.log(`Admin CLAWD:      ${adminBalance.toFixed(2)} CLAWD`);

  const neededClawd = Number(cfg.seedDepositAmount + cfg.insuranceAmount) / 1e6;
  if (adminBalance < neededClawd) {
    console.error(`ERROR: Need ${neededClawd} CLAWD but only have ${adminBalance.toFixed(2)}.`);
    console.error("Create CLAWD tokens first via: spl-token mint <CLAWD_MINT> <AMOUNT>");
    process.exit(1);
  }

  if (adminSol < 0.5e9) {
    console.warn(`WARNING: Low SOL balance (${(adminSol / 1e9).toFixed(4)} SOL).`);
    console.warn("Market creation requires ~0.44 SOL for rent + tx fees.");
    console.warn("Airdrop via: solana airdrop 5");
  }

  // Backup directory
  const backupDir = path.join(
    process.env.HOME!,
    ".percolator-mainnet",
    "markets",
    `devnet-clawd-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  console.log(`\nKeypair backup dir: ${backupDir}`);

  // Generate fresh keypairs
  const slab = Keypair.generate();
  const matcherCtx = Keypair.generate();
  saveKeypairBackup("slab", slab, backupDir);
  saveKeypairBackup("matcher-ctx", matcherCtx, backupDir);

  // Derive PDAs
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), slab.publicKey.toBuffer()],
    cfg.programId,
  );
  const lpIdxBuf = Buffer.alloc(2);
  lpIdxBuf.writeUInt16LE(0, 0);
  const [lpPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp"), slab.publicKey.toBuffer(), lpIdxBuf],
    cfg.programId,
  );
  const vaultAta = await getAssociatedTokenAddress(
    cfg.collateralMint,
    vaultPda,
    true,
  );

  console.log(`\nSlab:            ${slab.publicKey.toBase58()}`);
  console.log(`Matcher ctx:     ${matcherCtx.publicKey.toBase58()}`);
  console.log(`Vault PDA:       ${vaultPda.toBase58()}`);
  console.log(`Vault ATA:       ${vaultAta.toBase58()}`);
  console.log(`LP PDA (idx=0):  ${lpPda.toBase58()}`);
  console.log(`Admin ATA:       ${adminAta.toBase58()}\n`);

  // ============ TX1: InitMarket ============
  console.log("TX1: InitMarket (create slab + init market)...");

  const slabRent = await conn.getMinimumBalanceForRentExemption(cfg.slabSize);

  // For admin oracle mode: set indexFeedId to a non-zero dummy value.
  // This tells the program this is NOT Hyperp mode (which requires a DEX pool).
  // The oracle authority defaults to the admin who signs InitMarket.
  // We use a sentinel dummy feed ID that is all zeros except last byte = 1.
  const dummyFeedId = "0000000000000000000000000000000000000000000000000000000000000001";

  const initMarketData = encodeInitMarket({
    admin: admin.publicKey,
    collateralMint: cfg.collateralMint,
    indexFeedId: dummyFeedId,          // Non-zero = NOT Hyperp mode
    maxStalenessSecs: 120n,
    confFilterBps: 0,
    invert: 0,
    unitScale: 0,
    initialMarkPriceE6: cfg.initialMarkPriceE6,
    ...DEFAULT_INIT_EXTRA,
    ...DEFAULT_RISK_PARAMS,
  });

  console.log(`  encodeInitMarket: ${initMarketData.length} bytes`);

  const tx1 = new Transaction();
  tx1.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
  tx1.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
  tx1.add(
    SystemProgram.createAccount({
      fromPubkey: admin.publicKey,
      newAccountPubkey: slab.publicKey,
      lamports: slabRent,
      space: cfg.slabSize,
      programId: cfg.programId,
    }),
  );
  tx1.add(
    createAssociatedTokenAccountInstruction(
      admin.publicKey,
      vaultAta,
      vaultPda,
      cfg.collateralMint,
    ),
  );
  tx1.add(
    new TransactionInstruction({
      programId: cfg.programId,
      keys: buildAccountMetas(ACCOUNTS_INIT_MARKET, {
        admin: admin.publicKey,
        slab: slab.publicKey,
        mint: cfg.collateralMint,
        vault: vaultAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        clock: SYSVAR_CLOCK_PUBKEY,
        rent: SYSVAR_RENT_PUBKEY,
        dummyAta: adminAta,
        systemProgram: SystemProgram.programId,
      }),
      data: Buffer.from(initMarketData),
    }),
  );

  let sig1: string;
  try {
    sig1 = await sendTx(conn, tx1, [admin, slab], "TX1");
    await waitForAccountOwner(conn, slab.publicKey, cfg.programId, "TX1 slab", cfg.slabSize);
    await waitForAccountOwner(conn, vaultAta, TOKEN_PROGRAM_ID, "TX1 vault ATA");
  } catch (e) {
    console.error("TX1 FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  }

  // ============ TX2: SetDexPool (for admin mode, we still set a pool address — 
  //   the program requires SetDexPool to be called before enabling admin oracle.
  //   Actually for admin mode with non-zero indexFeedId, the DEX pool is optional.
  //   Let's skip TX2 for admin mode markets.)
  // ============
  console.log("TX2: Skipping SetDexPool (admin oracle mode — no DEX pool needed)");

  // ============ TX3: InitLP ============
  console.log(`TX3: InitLP (seed deposit: ${Number(cfg.seedDepositAmount) / 1_000_000} CLAWD)...`);

  const ctxRent = await conn.getMinimumBalanceForRentExemption(MATCHER_CTX_SIZE);

  const tx3 = new Transaction();
  tx3.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
  tx3.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
  tx3.add(
    SystemProgram.createAccount({
      fromPubkey: admin.publicKey,
      newAccountPubkey: matcherCtx.publicKey,
      lamports: ctxRent,
      space: MATCHER_CTX_SIZE,
      programId: MATCHER_PROG_ID,
    }),
  );
  tx3.add(
    new TransactionInstruction({
      programId: cfg.programId,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: slab.publicKey, isSigner: false, isWritable: true },
        { pubkey: adminAta, isSigner: false, isWritable: true },
        { pubkey: vaultAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(
        encodeInitLP({
          matcherProgram: MATCHER_PROG_ID,
          matcherContext: matcherCtx.publicKey,
          feePayment: cfg.seedDepositAmount,
        }),
      ),
    }),
  );

  let sig3: string;
  try {
    sig3 = await sendTx(conn, tx3, [admin, matcherCtx], "TX3");
    await waitForAccountOwner(conn, matcherCtx.publicKey, MATCHER_PROG_ID, "TX3 matcher ctx", MATCHER_CTX_SIZE);
    await waitForAccountOwner(conn, slab.publicKey, cfg.programId, "TX3 slab", cfg.slabSize);
  } catch (e) {
    console.error("TX3 FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  }

  // ============ TX4: InitMatcherCtx ============
  console.log("TX4: InitMatcherCtx (initialize matcher for LP slot 0)...");

  const tx4 = new Transaction();
  tx4.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  tx4.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
  tx4.add(
    new TransactionInstruction({
      programId: cfg.programId,
      keys: buildAccountMetas(ACCOUNTS_INIT_MATCHER_CTX, {
        admin: admin.publicKey,
        slab: slab.publicKey,
        matcherCtx: matcherCtx.publicKey,
        matcherProg: MATCHER_PROG_ID,
        lpPda,
      }),
      data: Buffer.from(encodeInitMatcherCtx(DEFAULT_MATCHER_CTX)),
    }),
  );

  let sig4: string;
  try {
    sig4 = await sendTx(conn, tx4, [admin], "TX4");
    await waitForAccountOwner(conn, matcherCtx.publicKey, MATCHER_PROG_ID, "TX4 matcher ctx", MATCHER_CTX_SIZE);
  } catch (e) {
    console.error("TX4 FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  }

  // ============ TX5: TopUpInsurance ============
  let sig5: string | null = null;
  if (cfg.insuranceAmount > 0n) {
    console.log(`TX5: TopUpInsurance (${Number(cfg.insuranceAmount) / 1_000_000} CLAWD)...`);

    const tx5 = new Transaction();
    tx5.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
    tx5.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
    tx5.add(
      new TransactionInstruction({
        programId: cfg.programId,
        keys: buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, {
          user: admin.publicKey,
          slab: slab.publicKey,
          userAta: adminAta,
          vault: vaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          clock: SYSVAR_CLOCK_PUBKEY,
        }),
        data: Buffer.from(
          encodeTopUpInsurance({ amount: cfg.insuranceAmount }),
        ),
      }),
    );

    try {
      sig5 = await sendTx(conn, tx5, [admin], "TX5");
    } catch (e) {
      console.warn("TX5 WARNING:", e instanceof Error ? e.message : e);
    }
  }

  // ============ TX6: InitStakePool ============
  console.log("TX6: InitStakePool (create insurance LP staking pool)...");

  const STAKE_COOLDOWN_SLOTS = 300n;
  const STAKE_DEPOSIT_CAP = 0n;

  const stakeLpMint = Keypair.generate();
  const stakeVault = Keypair.generate();
  saveKeypairBackup("stake-lp-mint", stakeLpMint, backupDir);
  saveKeypairBackup("stake-vault", stakeVault, backupDir);

  const [stakePool] = PublicKey.findProgramAddressSync(
    [Buffer.from("stake_pool"), slab.publicKey.toBuffer()],
    STAKE_PROG_ID,
  );
  const [stakeVaultAuth] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_auth"), stakePool.toBuffer()],
    STAKE_PROG_ID,
  );

  console.log(`  Stake pool PDA:   ${stakePool.toBase58()}`);
  console.log(`  Stake LP mint:    ${stakeLpMint.publicKey.toBase58()}`);

  const stakeMintRent = await conn.getMinimumBalanceForRentExemption(MINT_SIZE);
  const stakeTokenRent = await conn.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE);

  const tx6 = new Transaction();
  tx6.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  tx6.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
  tx6.add(
    SystemProgram.createAccount({
      fromPubkey: admin.publicKey,
      newAccountPubkey: stakeLpMint.publicKey,
      lamports: stakeMintRent,
      space: MINT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
  );
  tx6.add(
    SystemProgram.createAccount({
      fromPubkey: admin.publicKey,
      newAccountPubkey: stakeVault.publicKey,
      lamports: stakeTokenRent,
      space: TOKEN_ACCOUNT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
  );
  const initPoolData = Buffer.concat([
    Buffer.from([0]),
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(STAKE_COOLDOWN_SLOTS); return b; })(),
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(STAKE_DEPOSIT_CAP); return b; })(),
  ]);
  tx6.add(
    new TransactionInstruction({
      programId: STAKE_PROG_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: slab.publicKey, isSigner: false, isWritable: false },
        { pubkey: stakePool, isSigner: false, isWritable: true },
        { pubkey: stakeLpMint.publicKey, isSigner: false, isWritable: true },
        { pubkey: stakeVault.publicKey, isSigner: false, isWritable: true },
        { pubkey: stakeVaultAuth, isSigner: false, isWritable: false },
        { pubkey: cfg.collateralMint, isSigner: false, isWritable: false },
        { pubkey: cfg.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: initPoolData,
    }),
  );

  let sig6: string | null = null;
  try {
    sig6 = await sendTx(conn, tx6, [admin, stakeLpMint, stakeVault], "TX6");
    await waitForAccountOwner(conn, stakePool, STAKE_PROG_ID, "TX6 stake pool");
  } catch (e) {
    console.warn("TX6 WARNING:", e instanceof Error ? e.message : e);
  }

  // =====================================================================
  // Save market config
  // =====================================================================
  const marketJson = {
    programId: cfg.programId.toBase58(),
    slabAddress: slab.publicKey.toBase58(),
    matcherCtxAddress: matcherCtx.publicKey.toBase58(),
    lpPda: lpPda.toBase58(),
    vaultAta: vaultAta.toBase58(),
    collateralMint: cfg.collateralMint.toBase58(),
    dexPool: null,
    oracleMode: "admin",
    initialPriceE6: cfg.initialMarkPriceE6.toString(),
    stakePool: stakePool.toBase58(),
    stakeLpMint: stakeLpMint.publicKey.toBase58(),
    stakeProgramId: STAKE_PROG_ID.toBase58(),
    network: "devnet",
    createdAt: new Date().toISOString(),
    transactions: { sig1, sig3, sig4, sig5, sig6 },
  };

  const outFile = path.join(backupDir, "market.json");
  fs.writeFileSync(outFile, JSON.stringify(marketJson, null, 2));
  console.log(`\nMarket config saved to: ${outFile}`);

  // =====================================================================
  // Summary
  // =====================================================================
  console.log("\n========== CLAWD MARKET CREATED ==========");
  console.log(`Network:         devnet`);
  console.log(`Slab:            ${slab.publicKey.toBase58()}`);
  console.log(`Matcher ctx:     ${matcherCtx.publicKey.toBase58()}`);
  console.log(`LP PDA:          ${lpPda.toBase58()}`);
  console.log(`Vault ATA:       ${vaultAta.toBase58()}`);
  console.log(`Collateral:      ${cfg.collateralMint.toBase58()} (CLAWD)`);
  console.log(`Oracle mode:     admin`);
  console.log(`Initial price:   $${(Number(cfg.initialMarkPriceE6) / 1_000_000).toFixed(6)}`);
  console.log();
  console.log("Transactions:");
  console.log(`  TX1 InitMarket:     ${sig1}`);
  console.log(`  TX3 InitLP:         ${sig3}`);
  console.log(`  TX4 InitMatcherCtx: ${sig4}`);
  if (sig5) console.log(`  TX5 Insurance:      ${sig5}`);
  if (sig6) console.log(`  TX6 StakePool:      ${sig6}`);
  console.log();

  console.log("NEXT STEPS:");
  console.log("  1. Push oracle price: npx tsx scripts/push-clawd-price.ts");
  console.log("  2. Insert into Supabase markets table");
  console.log("  3. Restart keeper for cranking");
  console.log("  4. Start trading!");
  console.log("===========================================");
}

main().catch((e) => {
  console.error("Fatal error:", e instanceof Error ? e.message : e);
  process.exit(1);
});