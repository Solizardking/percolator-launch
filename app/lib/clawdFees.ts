/**
 * Shape of the mainnet desk's $CLAWD creator-fee raise meter
 * (GET https://mainnet.percolator.tech/api/clawd/fees), proxied by
 * /api/clawd/fees. Figures are computed by the desk from the on-chain
 * pump.fun creator-vault history; `fetchedAt` is the desk's read time.
 */
export interface ClawdFees {
  mint: string;
  goalSol: number;
  baselineSol: number;
  baselineAt: number;
  raisedSol: number;
  earnedSol: number;
  claimedSol: number;
  unclaimedSol: number;
  remainingSol: number;
  pct: number;
  goalReached: boolean;
  source: string;
  fetchedAt: number;
  stale: boolean;
}
