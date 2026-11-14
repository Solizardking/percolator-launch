# Our Version — Percolator Launch

Branch: `our-version` (off `main` @ `d3e105e`). Status: **pushed 2026-11-14**, including the Helius key removal below.

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

## Security fix — Helius API key removed from source + client code (2026-11-14)
The teardown found the live site's Helius API key in clear text in the shipped client bundle. In this source tree the key literal existed in `CLAWD.md` (an env block, 2 occurrences) and as a hard-coded fallback RPC URL in `scripts/setup-clawd-market.ts`. It reached the client bundle because client code built keyed Helius URLs from `NEXT_PUBLIC_*` env vars — and the deployed build had evidently been configured with this key in them (`NEXT_PUBLIC_HELIUS_WS_API_KEY` for WebSocket subscriptions in `app/lib/config.ts` + `app/components/providers/PrivyProviderClient.tsx`, `NEXT_PUBLIC_HELIUS_API_KEY` for the devnet faucet's direct connection in `app/hooks/useDevnetFaucet.ts`). Anything in a `NEXT_PUBLIC_*` variable is inlined into the client bundle at build time, so **no Helius key may live in one**.

What changed:
- `CLAWD.md`, `scripts/setup-clawd-market.ts` — key literal removed; the script now resolves RPC from `--rpc` / `RPC_URL` / `HELIUS_API_KEY` env, falling back to the public devnet RPC.
- `app/lib/config.ts` (`getWsEndpoint`), `app/components/providers/PrivyProviderClient.tsx` — WS subscriptions now always use the public Solana WS endpoints; no keyed WSS URL is constructed client-side. HTTP RPC already went through the same-origin `/api/rpc` proxy (server reads `HELIUS_API_KEY` / `HELIUS_MAINNET_API_KEY` / `HELIUS_DEVNET_API_KEY` from env) and still does.
- `app/hooks/useDevnetFaucet.ts` — SOL airdrop uses the public devnet faucet connection only (the previous server route pattern); the client-side keyed Helius connection is gone.
- `app/components/providers/WalletProvider.tsx` — removed the now-dead warning that compared the two `NEXT_PUBLIC_*` key vars.
- `app/__tests__/lib/config.test.ts` — the two WS tests now assert the key vars are ignored and public WS endpoints are returned.
- Env examples (`.env.example`, `app/.env.local.example`, `docs/env/frontend.env.mainnet.example`) — Helius vars documented as server-side only; the frontend example no longer instructs putting a key in `NEXT_PUBLIC_*` vars.

Verified: production build passes; the key literal occurs **0 times** in the working tree and **0 times** in the rebuilt `app/.next` output (and no `api-key=` string appears in any client chunk); the app's server-side Helius path via `/api/rpc` is unchanged.

**Caveats — rotation still required.** Removing the key from HEAD does not un-expose it:
- The key remains in **git history** (it entered in June 2026 commits `5d5db9e` / `f277f82`). History was deliberately NOT rewritten and nothing was force-pushed; purge/rewrite is a separate decision for the dev.
- The **live deployment** still serves the old bundle, and the deployment's env config (e.g. Vercel `NEXT_PUBLIC_HELIUS_WS_API_KEY` / `NEXT_PUBLIC_HELIUS_API_KEY`) must be cleared/replaced, or the next build will inline whatever key is configured there again.
- Therefore the key itself should be **rotated in the Helius dashboard** and treated as compromised; this fix only stops the source and future builds from re-shipping it.
- Residual: `NEXT_PUBLIC_HELIUS_RPC_URL` (read only in the server branch of `getRpcEndpoint`) would likewise be inlined if an operator sets it to a keyed URL — prefer a keyless value or rename it to a server-only var in a follow-up. Narrative docs (`docs/DEPLOYMENT.md`, `docs/MAINNET-*.md`, `docs/pre-mainnet-security-checklist.md`) still describe the old `NEXT_PUBLIC_*` key setup and should be updated to match.

## Known issues carried from the teardown
- ~~A Helius API key is hard-coded in the shipped client bundle~~ — fixed in source on this branch (see above); the live deployment still ships it until redeployed with cleaned env, and the key must be rotated (it remains in git history).
- Devnet matcher ID disagrees between app config (`GTRgyT…WfC9k`) and SDK constants (`4HcGCs…7Yfzy`) — runtime winner unproven.
- Creator-fee copy conflict: "$2,500 seed" (hero) vs "$1K seed vault" (mainnet beta banner).
