# dsh-haven-aol

Haven-AOL token-gated decryption for DeepSeek Harness: `ctx.aol` plus four model-facing tools over the [`haven-aol`](https://www.npmjs.com/package/haven-aol) TypeScript SDK and the ICP backend canister (mainnet `dciac-uaaaa-aaaad-qlzuq-cai`).

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

## The EIP-712 signing spike (blocking live decrypts)

The EIP-712 gate signature is the only signing operation. `ctx.wallet.signMessage` is **EIP-191** (personal prefix); the canister verifies `ecrecover` over the **raw EIP-712 digest** (`\x19\x01‖domain‖structHash`). A personal-prefixed signature is rejected with `#InvalidSignature`, and OWS exposes no `signDigest`/`signTypedData`. Until resolved, the `signGate` seam is **unset and every gated call throws `AolSigningError`** — fail-loud, no silently-invalid signature ever produced.

To resolve:

1. Probe OWS `signMessage`'s `encoding` parameter modes: for each mode, sign `TypedDataEncoder.hash(...)` output for a fixture gate request and check `ecrecover` locally.
2. If a mode yields raw secp256k1, inject `signGate` in `apply()` (wires to `ctx.wallet` + digest computation).
3. If none does, the fallback is a `signDigest` addition to `dsh-wallet-ethereum` — verify `@open-wallet-standard/core` exposes raw signing first.

Reads (`aol_gate_info`, `aol_epoch`) and client-side `aol_market_cap` Bond-pin rejection work without the spike.

## Config

```yaml
- id: haven-aol
  config:
    wallet: agent
    canisterId: dciac-uaaaa-aaaad-qlzuq-cai
    icpHost: https://icp-api.io
    fetchRootKey: false   # local replica only — never mainnet
```

`inject = ['wallet', 'tools']`. `ctx.synapse` is best-effort via `ctx.get()` — `aol_decrypt {cid}` needs `dsh-storage-synapse` mounted, otherwise pass `path`.

## Deferred (deliberately absent)

- `attestHolding` — no wrapper exists in any SDK yet (TS, Python, or here).
- Encrypt-side — the TS SDK is decrypt-side only; IBE-encrypt against `@icp-sdk/vetkeys` is unverified. Uploads stay in haven-cli until then.
