# dsh-haven-aol

Haven-AOL token-gated seal/decrypt for DeepSeek Harness: `ctx.aol` plus five model-facing tools over the `haven-aol` TypeScript SDK and the ICP backend canister (mainnet `gny6k-fqaaa-aaaab-ag3ra-cai`).

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
| `aol_seal` | execute | v1/v3/v4 | Harness-native encrypt: AES-GCM key (shared per epoch bucket for v3, fresh per seal for v1/v4, fresh IV always) + IBE wrap under the canister-fetched DPK. No wallet, no signature. |

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
    keyStorePath: /data/haven-aol/keys.json  # optional; unset = memory-only
```

`inject = ['wallet', 'tools']`. `ctx.synapse` is best-effort via `ctx.get()` — `aol_decrypt {cid}` needs `dsh-storage-synapse` mounted, otherwise pass `path`.

## Deferred (deliberately absent)

- `attestHolding` — no wrapper exists in any SDK yet (TS, Python, or here).

Sealing (`aol_seal`) is harness-native: v3/v4 metadata builders and derivation inputs stay SDK-verbatim, the v1 builder is ported from Python `core.py`, file bytes ship in haven-cli's framed chunk layout (`[12-byte base IV][u32LE index][u32LE length][ciphertext+tag]*`, 1 MiB chunks — players refuse unframed payloads over 32 MiB), and the IBE wrap runs against `@icp-sdk/vetkeys` under the **canister-fetched** verification key. Seal here, upload the sealed bytes plus `gateMetadataJson` via the storage tools. Decrypt dispatches on framing, so pre-framing legacy rows stay open.

## Key reuse (epoch buckets)

Upstream Bugs 4–6 fixed in the port: v3 is one key per epoch, not one per file.

- **Seal side** (`EpochAesKeyCache`): one AES key + wrapped blob per `(chain, token, threshold, epoch)` bucket. Every file sealed in the epoch carries the same `encryptedAesKey`; `keySha256` is the bucket commitment. v1 (per-file) and v4 (per-rung — sharing across rungs would let one unlock open later files) still mint per seal. IVs are fresh per seal in all versions, so every seal's bytes stay unique.
- **Decrypt side** (`VetKeyCache`): one signed canister round-trip per bucket, then local unwraps for every file in it. Lookups key off the derivation input from the gate metadata epoch — never the wall clock.
- **Custody**: both caches are memory-first with an optional durable store. The keys are tiny (32-byte AES, 48-byte vetKeys) and append-only, so a configured `keyStorePath` (e.g. `/data/haven-aol/keys.json`) keeps them across restarts in versioned JSON (0600, atomic tmp+rename, merge-on-save across runtimes — the xmtp outbox convention); unset keeps memory-only. Either way there is deliberately no revocation within an epoch (a member who held a bucket key could have saved the unwrapped file keys anyway). Gate denials are never cached.
