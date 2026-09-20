# dsh-haven-aol

Haven-AOL token-gated decryption for DeepSeek Harness: `ctx.aol` plus four model-facing tools over the `haven-aol` TypeScript SDK and the ICP backend canister (mainnet `gny6k-fqaaa-aaaab-ag3ra-cai`).

> TEMP: `haven-aol` is not on npm despite its README claim, so `package.json`
> uses `file:../../haven-aol/packages/typescript` (requires `npm install` +
> `npm run build` there first for `dist/`). This breaks isolated-bundle
> installs elsewhere — publish `haven-aol` to npm and revert to `"=0.1.0"`.

## Tools

| Tool | Kind | Versions | Notes |
|---|---|---|---|
| `aol_gate_info` | read | v1/v3/v4 | Pure metadata parse. v4 includes Bond-pin pre-check. |
| `aol_epoch` | read | — | Current 30-day epoch + rollover (advisory). |
| `aol_market_cap` | read | v4 | Live cap in whole reserve units (300s canister burst cache). Fails closed client-side on non-Bond oracles. |
| `aol_decrypt` | execute | v1/v3/v4 | Full gated decrypt; dispatches on metadata version. Keys never leave the call. |

Gate denials (`InsufficientBalance`, `MarketCapNotReached {required, actual}` in whole reserve units, `InvalidSignature`, `InvalidEpoch`, `InvalidOracle`) surface as tool errors the model can report verbatim.

## Sourcing rules

- Pure protocol (derivation preimages, epoch math, metadata build/parse, EIP-712 typed-data builders) is imported from the `haven-aol` SDK verbatim — fixture-pinned across Motoko/Python/TS, never re-derived here.
- v1 canister calls use the SDK's own `canister.ts` wrappers.
- v3/v4 canister calls (`requestDecryptionKeyV3/V4`, `getMarketCap`) are vendored in `src/aol.ts` following the SDK's IDL-factory pattern; record shapes copied from `src/backend/backend.did`. Upstream them to the SDK when convenient.

## The EIP-712 signing spike (resolved via raw-key provider)

The EIP-712 gate signature is the only signing operation. `ctx.wallet.signMessage` is **EIP-191** (personal prefix); the canister verifies `ecrecover` over the **raw EIP-712 digest** (`\x19\x01‖domain‖structHash`). A personal-prefixed signature is rejected with `#InvalidSignature`, and OWS exposes no `signDigest`/`signTypedData` through its Node wrapper (see `spike-ows-eip712.mjs`).

Resolution: skip OWS for the signing wallet — `dsh-wallet-ethereum` with `provider: raw` signs the digest raw via `ctx.wallet.signDigest`, which this plugin already prefers (`runtimeForCall`). No code changes were needed here:

```yaml
- id: wallet
  config:
    wallets:
      agent: { chain: evm, wallet: agent, keyRef: PRIVATE_KEY }
- id: wallet-ethereum
  config: { chains: [evm], provider: raw }
- id: haven-aol
  config:
    wallet: agent
    canisterId: gny6k-fqaaa-aaaab-ag3ra-cai
    icpHost: https://icp-api.io
    fetchRootKey: false
```

Without a wired `signDigest` (default OWS path), the `signGate` seam stays **unset and every gated call throws `AolSigningError`** — fail-loud, no silently-invalid signature ever produced. Reads (`aol_gate_info`, `aol_epoch`) and client-side `aol_market_cap` Bond-pin rejection work without any signer.

## Config

```yaml
- id: haven-aol
  config:
    wallet: agent
    canisterId: gny6k-fqaaa-aaaab-ag3ra-cai
    icpHost: https://icp-api.io
    fetchRootKey: false   # local replica only — never mainnet
```

`inject = ['wallet', 'tools']`. `ctx.synapse` is best-effort via `ctx.get()` — `aol_decrypt {cid}` needs `dsh-storage-synapse` mounted, otherwise pass `path`.

## Deferred (deliberately absent)

- `attestHolding` — no wrapper exists in any SDK yet (TS, Python, or here).
- Encrypt-side — the TS SDK is decrypt-side only; IBE-encrypt against `@icp-sdk/vetkeys` is unverified. Uploads stay in haven-cli until then.
