# CLAWD Perpetual Futures Market — Devnet Deployment Guide

> **Token:** solanaclawd (CLAWD)
> **Mainnet Mint:** `8cHzQHUS2s2h8TzCmfqPKYiM4dSt4roa3n7MyRLApump`
> **Devnet Mint:** `9iJ61cm9abZWuLfoJyoNNzinvM1mP66L5CrzNtcK3qbh`
> **Network:** Devnet (Solana)
> **Protocol:** Percolator — Permissionless Perpetual Futures

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Token Setup](#token-setup)
4. [Program IDs](#program-ids)
5. [Oracle Mode](#oracle-mode)
6. [Risk Parameters](#risk-parameters)
7. [Market Creation Script](#market-creation-script)
8. [Deployment Steps](#deployment-steps)
9. [Post-Deployment](#post-deployment)
10. [Transactions](#transactions)
11. [Trading on CLAWD Perp](#trading-on-clawd-perp)

---

## Overview

This document describes the setup of a **coin-margined CLAWD perpetual futures market** on Solana devnet using the Percolator protocol. The market allows traders to deposit CLAWD tokens as collateral, go long or short with up to 10x leverage, and have their PnL denominated entirely in CLAWD.

Unlike traditional USDC-margined perps, this is a **coin-margined** market — the same token being traded is also the collateral. Trading a CLAWD perp? You deposit CLAWD. PnL is in CLAWD.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     CLAWD Perp Market                         │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Slab Account (single on-chain account)                      │
│  ├─ Header (72 bytes) — magic, version, bump, admin, flags   │
│  ├─ MarketConfig (320 bytes) — collateral_mint = CLAWD       │
│  ├─ Engine State — mark price, funding, OI, EWMA             │
│  ├─ RiskParams — leverage, margins, fees, liquidation        │
│  ├─ Bitmap — used account slots                              │
│  └─ Accounts — per-user: owner, position, capital, PnL       │
│                                                              │
│  vAMM Matcher Context (320 bytes) — Passive LP slot 0        │
│  └─ Provides automatic initial liquidity via vAMM            │
│                                                              │
│  Stake Pool — Insurance LP staking                           │
│  ├─ LP Mint — earns fees from insurance fund                 │
│  └─ Vault — holds staked collateral                          │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

- **Coin-margined:** Collateral = CLAWD (not USDC). All PnL settles in CLAWD.
- **Admin Oracle:** Deployer pushes CLAWD/USD prices directly (no DEX pool dependency).
- **vAMM (Virtual AMM):** Automated Market Maker for initial liquidity — no external LPs needed to start.
- **Small Tier:** 256 user accounts, ~0.44 SOL rent — ideal for testing and early adoption.
- **Insurance Fund:** Seeded with CLAWD to protect against bad debt from liquidations.

---

## Token Setup

### Mainnet CLAWD Token

| Property | Value |
|----------|-------|
| Mint Address | `8cHzQHUS2s2h8TzCmfqPKYiM4dSt4roa3n7MyRLApump` |
| Symbol | CLAWD |
| Name | solanaclawd |
| Decimals | 6 |
| Total Supply | 990,978,770,299,998 CLAWD |
| Token Program | TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb (Token-2022) |

### Devnet CLAWD Token (Mirror)

Since the mainnet CLAWD token doesn't exist on devnet, we created a mirror token with identical decimals:

| Property | Value |
|----------|-------|
| **Mint Address** | **`9iJ61cm9abZWuLfoJyoNNzinvM1mP66L5CrzNtcK3qbh`** |
| Symbol | CLAWD |
| Name | solanaclawd |
| Decimals | 6 |
| Supply Minted | 10,000 CLAWD |
| Admin Wallet | `AAqkn72VgkZqFbWggn9SvzjzMRW5zsZrTe5VZKu9DwaM` |
| Admin ATA | `BU7my2SPuGZiV6obDurEMjNpTA5bw9Vhgc18AtB5eXVN` |

**Creation commands:**
```bash
# Create token mint (6 decimals)
spl-token create-token --decimals 6

# Create associated token account
spl-token create-account 9iJ61cm9abZWuLfoJyoNNzinvM1mP66L5CrzNtcK3qbh

# Mint supply for LP seeding
spl-token mint 9iJ61cm9abZWuLfoJyoNNzinvM1mP66L5CrzNtcK3qbh 10000000000
```

---

## Program IDs

### Devnet Program Deployments

| Tier | Max Accounts | Rent | Program ID |
|------|-------------|------|------------|
| **Small** (USED) | 256 | ~0.44 SOL | `FwfBKZXbYr4vTK23bMFkbgKq3npJ3MSDxEaKmq9Aj4Qn` |
| Medium | 1024 | ~1.73 SOL | `g9msRSV3sJmmE3r5Twn9HuBsxzuuRGTjKCVTKudm9in` |
| Large | 4096 | ~6.87 SOL | `FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD` |

| Component | Program ID | Purpose |
|-----------|-----------|---------|
| **Engine** | `FwfBKZXbYr4vTK23bMFkbgKq3npJ3MSDxEaKmq9Aj4Qn` | Core perp logic (small tier) |
| **Matcher** | `GTRgyTDfrMvBubALAqtHuQwT8tbGyXid7svXZKtWfC9k` | vAMM matching engine |
| **Stake** | `DC5fovFQD5SZYsetwvEqd4Wi4PFY1Yfnc669VMe6oa7F` | Insurance LP staking |

> **Note:** The engine program was chosen as the small tier (FwfBK...) for lower rent cost. Each tier has a separate on-chain program compiled with different `--features` flags.

---

## Oracle Mode

The market uses **Admin Oracle Mode** because CLAWD has no DEX pool on devnet.

### Oracle Mode Comparison

| Oracle Mode | Description | When to Use |
|------------|-------------|-------------|
| **Admin** | Deployer pushes prices via `PushOraclePrice` instruction | Custom tokens, no DEX pool |
| **Hyperp (DEX)** | Price derived from PumpSwap/Raydium/Meteora pool | Tokens with active DEX pools |
| **Pyth-Pinned** | Price via Pyth oracle CPI | Major tokens (SOL, BTC, ETH) |

### How Admin Oracle Works

1. During `InitMarket`, we set `indexFeedId` to a **non-zero dummy value** (`0000...0001`)
2. This signals the program this is **NOT** Hyperp mode (which requires a DEX pool)
3. The oracle authority defaults to the admin who signs `InitMarket`
4. The admin pushes CLAWD/USD prices by calling `PushOraclePrice` with:
   - The market's slab address
   - A price in E6 format (e.g., `1000000` = $1.00)
   - A timestamp

**Key insight:** The dummy feed ID differentiates between oracle modes at the program level:
- `indexFeedId == [0;32]` → Hyperp mode (DEX pool required)
- `indexFeedId != [0;32]` → Admin or Pyth mode (DEX pool optional)

### Price Push Script (Post-Deployment)

```typescript
// scripts/push-clawd-price.ts
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
// Uses PushOraclePrice (tag=9) to push CLAWD/USD price
// Frequency: every oracle staleness window (~120s)
// Source: can be CoinGecko, DexScreener, or manual
```

---

## Risk Parameters

### Market Configuration

| Parameter | Value | Meaning |
|-----------|-------|---------|
| Maintenance Margin | 500 bps (5%) | Liquidation threshold |
| Initial Margin | 1000 bps (10%) | Required to open position = **10x max leverage** |
| Trading Fee | 10 bps (0.1%) | Per-trade fee |
| Max Accounts | 256 | Small tier capacity |
| New Account Fee | 1 CLAWD | Cost to create a user account |
| Max Crank Staleness | 300 slots (~5 min) | How long before crank is stale |
| Liquidation Fee | 50 bps (0.5%) | Fee for liquidators |
| Liquidation Fee Cap | 100 CLAWD | Max liquidation reward |
| Min Initial Deposit | 2 CLAWD | Minimum to open a position |
| Min Price Cap | 5% | Minimum oracle price movement cap |

### vAMM Matcher Configuration

| Parameter | Value | Meaning |
|-----------|-------|---------|
| Trading Fee | 30 bps (0.30%) | vAMM fee |
| Base Spread | 10 bps | Spread at zero inventory |
| Max Total | 200 bps | Maximum total spread |
| Impact K | 100 bps | How much trades move the price |
| Liquidity Notional | $1,000 | Available vAMM liquidity |
| Max Inventory | 10 CLAWD | Maximum vAMM inventory |
| Fee to Insurance | 2000 bps (20%) | Portion of fees going to insurance fund |

---

## Market Creation Script

The deployment script `scripts/setup-clawd-market.ts` executes 4-6 on-chain transactions:

### Transaction Flow

```
TX1: InitMarket
  ├─ SystemProgram.createAccount (slab, data_size, rent-exempt)
  ├─ createAssociatedTokenAccount (vault ATA)
  └─ Percolator.InitMarket (tag=0, 370 bytes)
      └─ Sets RiskParams, admin, oracle mode, initial mark price

TX2: SetDexPool — SKIPPED for admin oracle mode

TX3: InitLP
  ├─ SystemProgram.createAccount (matcher ctx, 320 bytes)
  └─ Percolator.InitLP (tag=2)
      └─ Seeds LP slot 0 with 5,000 CLAWD deposit

TX4: InitMatcherCtx
  └─ Percolator.InitMatcherCtx (CPI to matcher program)
      └─ Initializes passive vAMM

TX5: TopUpInsurance (optional)
  └─ Seeds insurance fund with 1,000 CLAWD

TX6: InitStakePool (optional)
  ├─ SystemProgram.createAccount (stake LP mint + vault)
  └─ Stake.InitPool
      └─ Creates insurance LP staking pool
```

### Key Addresses (Pre-computed)

These are deterministic based on the slab keypair generated at runtime:

| Account | PDA Derivation |
|---------|---------------|
| **Vault PDA** | `findProgramAddress(["vault", slab])` |
| **Vault ATA** | `getAssociatedTokenAddress(vault, CLAWD_mint)` |
| **LP PDA (idx=0)** | `findProgramAddress(["lp", slab, 0])` |
| **Stake Pool** | `findProgramAddress(["stake_pool", slab])` |

### Script Usage

```bash
# Set environment
export RPC_URL="https://devnet.helius-rpc.com/?api-key=YOUR_KEY"
export KEYPAIR_PATH="/path/to/admin-keypair.json"
export COLLATERAL_MINT="9iJ61cm9abZWuLfoJyoNNzinvM1mP66L5CrzNtcK3qbh"

# Run deployment
cd /Users/8bit/Dark-Defi/percolator-launch
npx tsx scripts/setup-clawd-market.ts

# With inline env
COLLATERAL_MINT=9iJ61cm9abZWuLfoJyoNNzinvM1mP66L5CrzNtcK3qbh \
  npx tsx scripts/setup-clawd-market.ts
```

---

## Deployment Steps

### Prerequisites

- **SOL Balance:** At least 0.5 SOL for rent + tx fees
- **CLAWD Balance:** 6,000+ CLAWD (5,000 LP + 1,000 insurance)
- **Solana CLI:** v3.1.9+ configured for devnet

### Step-by-Step

1. **Fund the admin wallet:**
```bash
solana config set --url "https://devnet.helius-rpc.com/?api-key=YOUR_KEY"
solana airdrop 1
```

2. **Create CLAWD tokens** (if not already done):
```bash
spl-token create-token --decimals 6
# Mint: 9iJ61cm9abZWuLfoJyoNNzinvM1mP66L5CrzNtcK3qbh
spl-token create-account <MINT>
spl-token mint <MINT> 6000000000
```

3. **Deploy the perp market:**
```bash
COLLATERAL_MINT=9iJ61cm9abZWuLfoJyoNNzinvM1mP66L5CrzNtcK3qbh \
  npx tsx scripts/setup-clawd-market.ts
```

4. **After successful deployment**, push oracle prices:
```bash
npx tsx scripts/push-clawd-price.ts --slab <SLAB_ADDRESS> --price 1000000
```

5. **Insert into Supabase:**
```sql
INSERT INTO markets (slab_address, symbol, name, collateral_mint, 
  oracle_mode, program_id, network, mint_address, decimals, 
  initial_price_e6, max_leverage, trading_fee_bps)
VALUES (
  '<SLAB_ADDRESS>', 
  'CLAWD-PERP', 
  'CLAWD/USD Perpetual', 
  '9iJ61cm9abZWuLfoJyoNNzinvM1mP66L5CrzNtcK3qbh',
  'admin', 
  'FwfBKZXbYr4vTK23bMFkbgKq3npJ3MSDxEaKmq9Aj4Qn', 
  'devnet',
  '9iJ61cm9abZWuLfoJyoNNzinvM1mP66L5CrzNtcK3qbh',
  6,
  1000000,
  10,
  10
);
```

6. **Restart the keeper bot** to start cranking:
```bash
# The keeper discovers new markets and starts processing cranks
```

---

## Post-Deployment

### Market Operations

Once live, the market requires ongoing maintenance:

| Operation | Frequency | Description |
|-----------|-----------|-------------|
| **Crank** | Every ~30s | Advance market state, update funding, process liquidations |
| **Oracle Push** | Every ~120s | Push current CLAWD/USD price (before price staleness) |
| **Liquidation** | Continuous | Monitor and execute undercollateralized positions |

### Admin Actions

The admin wallet (deployer) can:
- Push oracle prices (`PushOraclePrice`)
- Pause/unpause the market (`PauseMarket` / `UnpauseMarket`)
- Set risk thresholds (`SetRiskThreshold`)
- Add insurance fund (`TopUpInsurance`)
- Renounce admin (`RenounceAdmin`)

### Keeper Crank

The keeper cranks the market to:
1. Calculate and update funding rate
2. Update mark price from oracle
3. Process pending liquidations
4. Advance EWMA price metrics

---

## Transactions

### Expected Output

After successful deployment, the script outputs:

```
TX1 InitMarket:     https://solscan.io/tx/...?cluster=devnet
TX3 InitLP:         https://solscan.io/tx/...?cluster=devnet
TX4 InitMatcherCtx: https://solscan.io/tx/...?cluster=devnet
TX5 Insurance:      https://solscan.io/tx/...?cluster=devnet
TX6 StakePool:      https://solscan.io/tx/...?cluster=devnet
```

### Market Config (Saved to File)

```json
{
  "programId": "FwfBKZXbYr4vTK23bMFkbgKq3npJ3MSDxEaKmq9Aj4Qn",
  "slabAddress": "<generated>",
  "matcherCtxAddress": "<generated>",
  "lpPda": "<PDA>",
  "vaultAta": "<ATA>",
  "collateralMint": "9iJ61cm9abZWuLfoJyoNNzinvM1mP66L5CrzNtcK3qbh",
  "dexPool": null,
  "oracleMode": "admin",
  "stakePool": "<PDA>",
  "stakeLpMint": "<generated>",
  "network": "devnet"
}
```

---

## Trading on CLAWD Perp

### Opening a Position

1. **Deposit CLAWD** into the market vault
2. **Choose direction:** Long (↑) or Short (↓)
3. **Set leverage:** Up to 10x
4. **Execute trade:** via vAMM or limit order

### Position Management

- **PnL:** Denominated in CLAWD
- **Funding Rate:** Periodic payments between longs and shorts
- **Liquidation:** Triggered when maintenance margin < 5%
- **Insurance Fund:** Protects against bad debt

### Risk Warnings

- Trading perps carries **significant risk**
- Leverage amplifies both gains and losses
- Always monitor positions and funding rates
- Devnet tokens have no real value

---

## Environment Variables

```bash
# .env — Devnet Configuration
RPC_URL=https://devnet.helius-rpc.com/?api-key=f1598ee2-cd64-4bad-881d-fce6e386665c
HELIUS_API_KEY=f1598ee2-cd64-4bad-881d-fce6e386665c
NETWORK=devnet
PROGRAM_ID=FwfBKZXbYr4vTK23bMFkbgKq3npJ3MSDxEaKmq9Aj4Qn
ALL_PROGRAM_IDS=FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD,FwfBKZXbYr4vTK23bMFkbgKq3npJ3MSDxEaKmq9Aj4Qn,g9msRSV3RFRFSqMeyjmiSAHfKcLFqYSWB7YXZBhNb2V
KEYPAIR_PATH=/Users/8bit/.config/solana/id.json
COLLATERAL_MINT=9iJ61cm9abZWuLfoJyoNNzinvM1mP66L5CrzNtcK3qbh
```

---

## Resources

- **Percolator Launch:** https://github.com/dcccrypto/percolator-launch
- **Percolator SDK:** `@percolatorct/sdk` v2.0.9
- **Devnet RPC:** Helius devnet with API key
- **Explorer:** https://solscan.io/?cluster=devnet
- **Mainnet CLAWD:** `8cHzQHUS2s2h8TzCmfqPKYiM4dSt4roa3n7MyRLApump`

---

## Quick Reference

```bash
# ═══════════════════════════════════════════════
# CLAWD Perp Market — Quick Deploy
# ═══════════════════════════════════════════════

# Token
  Mint:    9iJ61cm9abZWuLfoJyoNNzinvM1mP66L5CrzNtcK3qbh
  Symbol:  CLAWD
  Decimals: 6

# Programs
  Engine:  FwfBKZXbYr4vTK23bMFkbgKq3npJ3MSDxEaKmq9Aj4Qn  (small tier)
  Matcher: GTRgyTDfrMvBubALAqtHuQwT8tbGyXid7svXZKtWfC9k
  Stake:   DC5fovFQD5SZYsetwvEqd4Wi4PFY1Yfnc669VMe6oa7F

# Oracle: Admin (deployer pushes prices)

# Risk
  Max Leverage:  10x
  Maintenance:   5%
  Trading Fee:   0.1%
  LP Deposit:    5,000 CLAWD
  Insurance:     1,000 CLAWD

# Deploy
  npx tsx scripts/setup-clawd-market.ts

# Push Price (post-deploy)
  npx tsx scripts/push-clawd-price.ts --slab <ADDR> --price 1000000
```

---

*Created: June 11, 2026*
*Protocol: Percolator (by Anatoly Yakovenko)*
*Token: solanaclawd (CLAWD)*