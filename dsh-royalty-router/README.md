# dsh-royalty-router

mint.club graduation advisor + launcher for DeepSeek Harness: `rr_advise` (model-backed launch params), `rr_venue` (curve-vs-pool quotes), `rr_build` (launch dry-run), `rr_launch` (approve → simulate → send), `rr_sweep` (pending royalties into locked liquidity), `rr_heartbeat` (activity stamp) over [`@royalty-router/sdk`](../../../mint-glue-graduate/sdk) (mint-glue-graduate). Reads are free; execute tools sign per operation through `ctx.wallet` — no signing, no spending, no private key in Node or config.

> Installation note: `@royalty-router/sdk` is not on npm yet, so
> `package.json` uses `file:../../mint-glue-graduate/sdk` (requires that
> checkout present for install/build). After the SDK is published to npm,
> revert to `"=0.1.0"`. Same story as `haven-aol`; do both publishes in
> one pass.

## Tools

| Tool | Kind | Network | Notes |
|---|---|---|---|
| `rr_advise` | read | none (offline) | Fills `recommendedIntent` (15% royalty both ways, 0.3% pool fee, smooth 20-step curve, hard seed) from `{name, symbol, reserveToken, feeRecipient, curve}` + optional overrides, or advises an explicit-steps intent. Returns `{intent, advice[], bandBps}`. Empty advice = matches the model. |
| `rr_venue` | read | live RPC | `readVenueState` + `quoteVenues` + `crossoverSize` for `{token, secondary?, fee?, tickSpacing?, side, amountIn}`. Bigints cross as decimal strings (the `rr` CLI convention). |
| `rr_build` | read | live RPC | Full `buildLaunch` dry-run: struct, `msg.value`, approvals, predicted token/poolId. **Requires `factory` in config** — fails actionable without it. Until the live factory is deployed, point at a local fork. Signs nothing. |
| `rr_launch` | execute | live RPC + sends txs | `buildLaunch` then approve (if needed) → simulate → send. Caller funds the reserve/seed in the configured wallet. Signs via `ctx.wallet`. |
| `rr_sweep` | execute | live RPC + sends txs | Sweeps one router's pending royalties into locked liquidity (`{router, minOut?}`). Simulates first. Call when ready (pending clears `MIN_CLAIM`); else `rr_heartbeat`. Signs via `ctx.wallet`. |
| `rr_heartbeat` | execute | live RPC + sends txs | Permissionless activity stamp for a router with nothing worth sweeping (`{router}`). Moves no funds, still sends a tx. Signs via `ctx.wallet`. |

Reads are `presentCall: {kind:'read'}` — free, never gated, never metered. Execute tools are `presentCall: {kind:'execute'}` — metered/gated by treasury policy like any other spend.

## Config

```yaml
- id: royalty-router
  config:
    rpcUrl: https://mainnet.base.org
    chainId: 8453
    # factory: 0x...   # rr_build / rr_launch; until the live factory is deployed
    # wallet: my-wallet # dsh-wallet name signing rr_launch / rr_sweep / rr_heartbeat
```

`inject = ['tools']` only, so the advisor reads mount anywhere. Execute tools additionally need `ctx.wallet` (`dsh-wallet` + `dsh-wallet-ethereum`) and a `wallet:` name — without them they fail actionable and the reads keep working. The plugin holds no secrets: configuration carries names and credential references, signing happens per operation inside `dsh-wallet`. Bigint args arrive as decimal strings and are validated (`0x`-address shape, decimal-integer shape) with actionable errors.

## What is deliberately absent (keeper loop)

The keeper loop stays out: surface `routerStatus`-style reads and let Gelato/cron consume them (see `mint-glue-graduate/keeper/sweep.sh` for the condition). No new custody code was needed for the execute tools — they reuse the `dsh-storage-synapse` viem `toAccount` wallet bridge (`ctx.wallet.signTransaction`, works with both `ows` and `raw` providers).

## Trust notes (mirror in tool descriptions)

- `rr_build` output is a dry-run: simulate before sending, and on swapper routes quote a real `minOut` — the reference swapper trusts the caller's floor.
- Venue math is the full-range constant-product case the program position creates; curve math mirrors `MCV2_Bond` exactly (see `@royalty-router/sdk` README).
- mint.club's 20% protocol cut is taken before any router sees funds and is not routable.

## Tests

Offline seam proofs (`tests/router.spec.ts`, no network): model-default fill + empty advice, 3%-royalty and coarse-step warnings (vectors from `sdk/example.intent.json` shape), input validation, bigint/JSON safety, factory guard, execute arg validation, stubbed-client venue quote. Fork suites (need `FORK_RPC` + `FORK_FACTORY`): `tests/fork-e2e.spec.ts` (wiring, live bond/factory reads, dry-run, funded simulation), `tests/fork-venue.spec.ts` (live venue quotes, router status, recommended-model pass), `tests/fork-execute.spec.ts` (real launch → sweep → heartbeat on a local fork). `scripts/fork-launch.mjs` launches a token out-of-band via the SDK path for local fork testing.
