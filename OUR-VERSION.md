# Our Version — Percolator Launch

Branch: `our-version` (off `main` @ `d3e105e`). Status: **verified locally, not pushed** — pushing waits for the dev's word.

## What this repo is
`Solizardking/percolator-launch` is the dev's fork of `dcccrypto/percolator-launch` — the actual source of https://percolator-launch.vercel.app/ (the live site's footer links the upstream repo; its canonical domain is percolator.trade). So "our version" is not a rewrite: it is this fork, reconciled against the live deployment and proven to build and run. Full teardown: `~/workspace/percolator-launch-re/notes/` (findings.md, SPEC.md, inventory.md, bundle-findings.md, local-run.md).

## Reconciliation vs the live vercel.app deployment (2026-11-14)
Matches: every program ID (mainnet/devnet perps, matcher, crank, slab-tier programs, test USDC), CSP connect-src list, Supabase project ref, Privy app id, and every client-called API endpoint in the shipped bundles exists in this source.
Differences (config/flag level, not code level):
1. Live deployment defaults to **devnet**; `app/vercel.mainnet.json` describes the mainnet variant. Local run below uses devnet.
2. Live deployment 404s `/vote`, `/allocation`, `/api/vote/*`, `/api/allocation/*` — present in this source; hidden or not-yet-deployed there.
3. The exact commit the live deployment was built from is UNKNOWN (likely ≤ fork HEAD or feature-flagged).

## Run it
```bash
# prerequisites: Node 20+ (verified on v24.22.1), pnpm 10
pnpm install                      # repo root, ~20 min first time
cp app/.env.local.example app/.env.local   # then fill what you have (see blockers)
pnpm --filter @percolator/app build
cd app && ./node_modules/.bin/next start -p 3000   # http://localhost:3000
# dev mode: pnpm --filter @percolator/app dev
```
Verified 2026-11-14: install OK (1,341 pkgs), production build OK, all 15 probed routes return 200 (`/ /markets /create /launch /trade /earn /guide /developers /agents /leaderboard /stake /portfolio /dashboard /wallet /join`).

## Parity checklist
- [x] Pages/routes: all live routes present and serving (superset: + vote/allocation/admin extras)
- [x] Homepage copy, stats strip, launch/trade/earn flows: same source as live
- [x] Program IDs / network config: identical to shipped bundle
- [x] Wallet pattern: Privy + external adapters, browser signing only
- [ ] Live data locally: BLOCKED-BY-ENV — needs Supabase URL/keys, Privy app secret + allowlists, Helius key (else rate-limited public RPC), backend API on :4000 (services in Dockerfiles at repo root, not run)
- [ ] Unit tests fully green: 3,496 passed / 15 failed / 135 skipped — failures pre-existing on this branch in 5 files (`useStuckSlabs` mock missing `useWalletCompat`, `admin-session-security-v2`, `oracle-advance-phase`, `playground-gate`, `upstash-rate-limit`)

## Known issues carried from the teardown
- A Helius API key is hard-coded in the shipped client bundle (devnet RPC + mainnet WS). Rotation is the dev's call.
- Devnet matcher ID disagrees between app config (`GTRgyT…WfC9k`) and SDK constants (`4HcGCs…7Yfzy`) — runtime winner unproven.
- Creator-fee copy conflict: "$2,500 seed" (hero) vs "$1K seed vault" (mainnet beta banner).
