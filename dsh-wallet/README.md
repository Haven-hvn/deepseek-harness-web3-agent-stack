# dsh-wallet

Wallet capability seam for DeepSeek Harness: `ctx.wallet` runs named wallets
over pluggable chain adapters. Configuration carries a credential *reference*
(`keyRef`, resolved through `ctx.credentials`), never a key — the secret value
exists only inside one operation, between resolution and the adapter call.

Concept lineage: haven-core's `WalletIdentity` machine ("the private key NEVER
leaves this machine boundary — other machines request signatures, they don't
access keys") and its `CryptoAdapter` port, translated to dsh seams. Haven's
`loadKey("env:VAR" | "0x…")` string is replaced by the dsh credential seam:
references in config, values at the operation boundary. There is no raw-key
config path at all — a pasted key fails the `CredentialRef` pattern at plugin
load with an actionable error.

## Install

```sh
dsh plugin --profile <name> add /path/to/dsh-wallet
```

The package declares `dsh.bundle`, so installing it activates its
`cordis.patch.yml` layer (one `wallet` row over `dsh-base`, whose
`credentials` row supplies the provider). Configure wallets in your profile's
`cordis.patch.yml`:

```yaml
- id: wallet
  config:
    wallets:
      treasury:
        chain: evm
        wallet: agent-treasury           # provider-scoped selector (e.g. OWS vault wallet name)
        keyRef: HAVEN_WALLET_PASSPHRASE  # credential REFERENCE — never a key
```

Install one adapter bundle per chain family you sign on (e.g.
[`dsh-wallet-ethereum`](../dsh-wallet-ethereum/README.md) for `evm`).

## API

Service `ctx.wallet` (`WalletRuntime`, injects `credentials`):

- `register(chain, adapter): () => void` — provider registration with a
  stale-safe disposer. `adapter` implements the `CryptoAdapter` contract
  (`loadKey(source)` / `signMessage(keyMaterial, payload)` /
  `signTransaction(keyMaterial, payload)`; see `src/types.ts`).
- `list(): WalletInfo[]` — configured wallets with configuration facts only
  (`keyRefConfigured`, `adapterRegistered`); never secrets.
- `address(name): Promise<WalletAddress>` — derive the public address.
- `signMessage(name, payload)` / `signTransaction(name, payload)` —
  `Promise<{ address, signature }>`. Sign-only: broadcasting belongs to
  whoever holds the signed payload.

Every operation runs resolve → `loadKey` → sign → drop: `ctx.credentials
.resolve(keyRef)` is called inside the operation (never cached, per the
credentials-seam contract), the resolved value rides the operation-scoped
`WalletKeySource`, and no reference to it or to adapter `keyMaterial` survives
the call. A rotated credential reaches the very next signature without a
restart.

Errors are `WalletError` with stable codes: `wallet-not-found`,
`chain-unsupported`, `credential-unconfigured`, `invalid-key-ref`,
`duplicate-adapter`.

Event `wallet/signed` (emit) fires after each completed signing operation with
`{ wallet, chain, operation, address }` — identity facts for audit, never
material.

## Extension points

- Implement `CryptoAdapter` and `ctx.effect(() => ctx.wallet.register(chain,
  adapter))` from a provider plugin. What `WalletKeySource.secret` *means* is
  the adapter's custody model: OWS adapters treat it as the vault passphrase /
  `ows_key_…` token (the private key stays in the OWS vault); a raw-key
  adapter would treat it as key material.
- `wallet/signed` for audit trails.

## Model Experience

None directly: this package registers no tools and contributes no prompt
sections, so it has no model-visible surface, token cost, or KV-cache effect.
A separate tool plugin may expose signing to the model; gate it with policy
(e.g. `dsh-treasury`'s `tools/pre-execute` gate) before doing so.

## Known Limitations and Deferred Work

- No concurrency coordination across operations on one wallet (no nonce
  manager); callers needing strict transaction ordering serialize above this
  seam, matching the OWS concurrency stance.
- No model-facing signing tool ships here by design — exposing signatures to
  the model is a deployment decision that belongs with an explicit policy
  gate.
- `address()` establishes a full signing context in adapters whose custody
  model requires authorization even for address derivation; a cheaper
  read-only path is deferred until an adapter needs it.
