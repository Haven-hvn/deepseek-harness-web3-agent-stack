# dsh-wallet-ethereum

OWS-backed Ethereum signing provider for the [`dsh-wallet`](../dsh-wallet/README.md)
seam. Implements the `CryptoAdapter` contract (Haven's adapter shape) by
delegating every cryptographic operation to
[`@open-wallet-standard/core`](https://www.npmjs.com/package/@open-wallet-standard/core)
— the Rust core running in-process via NAPI.

This is the haven-adapters OWS migration plan
(`haven-adapters/docs/01-ows-crypto-adapter-migration-plan.md`) realized as a
dsh plugin, with the plan's open decisions settled the dsh way:

- **Key source.** Haven's `loadKey("env:VAR" | "0x…")` is gone. The wallet
  seam resolves a `CredentialRef` per operation and hands the adapter a
  structured `WalletKeySource`; the secret is the OWS *credential* (vault
  passphrase or `ows_key_…` API token), not a private key. Keys live in the
  OWS vault, are decrypted per call behind OWS's policy engine, and are
  zeroized after each operation — they never enter this process.
- **`keyMaterial`.** A typed `OwsKeyContext` session descriptor (wallet id,
  chain, credential, account index) — no `any`, no key bytes, operation-scoped.
- **Sign-only.** `signTransaction` maps to OWS `signTransaction`, never
  `signAndSend`; broadcasting belongs to whoever holds the signed payload.
- **Multi-chain by standard.** OWS derives all chain families from one vault
  wallet, so one adapter class serves any family (`evm`, `solana`, `bitcoin`,
  `cosmos`, `tron`, `ton`, `sui`, `xrpl`, `filecoin`) rather than
  implementing each chain by hand; `evm` is this package's default. Errors
  (`WALLET_NOT_FOUND`, `POLICY_DENIED`, `INVALID_PASSPHRASE`,
  `API_KEY_EXPIRED`, …) translate to actionable adapter-level messages.

## Install

```sh
dsh plugin --profile <name> add /path/to/dsh-wallet /path/to/dsh-wallet-ethereum
dsh plugin --profile <name> add @open-wallet-standard/core
```

`@open-wallet-standard/core` is an optional peer: composition and tests load
without it (the import is lazy with an actionable failure), real signing needs
it. Prebuilt binaries ship for macOS (arm64, x64) and Linux (x64, arm64).

Configure a wallet against your OWS vault in the profile's `cordis.patch.yml`:

```yaml
- id: wallet
  config:
    wallets:
      treasury:
        chain: evm
        wallet: agent-treasury           # OWS vault wallet name (ows wallet create agent-treasury)
        keyRef: HAVEN_WALLET_PASSPHRASE  # credential REFERENCE to the passphrase or ows_key_… token
```

## Config

| key | default | meaning |
|---|---|---|
| `chains` | `[evm]` | chain families to register this adapter for |
| `vaultPath` | OWS default (`~/.ows`) | vault directory root |
| `accountIndex` | `0` | account index within each wallet's derivation path |

## Extension points

- `internals.signer` — test seam replacing the native bindings with a fake
  `OwsSigner` (set before the plugin mounts; the native import never runs).
- `OwsEthereumCryptoAdapter` is exported for direct construction in bespoke
  compositions.

## Model Experience

None: no tools, no prompt sections, no model-visible surface, token cost, or
KV-cache effect.

## Known Limitations and Deferred Work

- No per-wallet nonce management or same-wallet request serialization —
  matching the OWS concurrency stance; callers coordinate above the seam.
- EIP-712 typed-data and EIP-7702 authorization signing (OWS `signTypedData`,
  `signAuthorization`) are not surfaced because the seam contract carries only
  Haven's message/transaction pair; extend the seam first when a consumer
  exists.
- The optional-peer range for `@open-wallet-standard/core` is `*` because the
  package tracks a young standard; pin a tested version in your profile.
