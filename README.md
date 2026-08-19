# dsh-web3

Reimplementation of the sovereign web3 agent harness using DeepSeek harness as core, where everything is a plug-in. Replaces https://github.com/Haven-hvn/haven-core and https://github.com/Haven-hvn/haven-adapters

There is deliberately **no aggregate bundle**: people may want one capability
and not another, so each package ships its own `dsh.bundle.patch` →
`cordis.patch.yml` inserting only its own rows, and installs independently:

```sh
dsh plugin --profile <name> add /path/to/dsh-haven/<package>
```

## The packages

| Package | Haven concept | dsh seam it lands on |
| --- | --- | --- |
| [`dsh-wallet`](./dsh-wallet) | `WalletIdentity` custody ("the key never leaves this boundary") + the `CryptoAdapter` contract | `ctx.wallet` service; credentials resolved through `ctx.credentials` per operation — configuration carries *references*, never keys |
| [`dsh-wallet-ethereum`](./dsh-wallet-ethereum) | `EthereumCryptoAdapter` → OWS migration plan | provider plugin registering a `CryptoAdapter` per chain family, backed by `@open-wallet-standard/core` (sign-only; the standard handles all chain families) |
| [`dsh-treasury`](./dsh-treasury) | `Treasury` machine: balances, expenses, FUNDED/LOW/CRITICAL/DEPLETED survival gradient | storage-domain tables + derived state; a policy plugin short-circuits `agent/request` and `tools/pre-execute`, metered off `llm/token-meter` |
| [`dsh-channel-xmtp`](./dsh-channel-xmtp) | `XmtpChannel` direct agent↔user messaging | one dsh agent per conversation (`ctx.agents`), inbound via `agent.followup`, replies via `sendText`; EOA identity signs through `ctx.wallet` |
| [`dsh-storage-synapse`](./dsh-storage-synapse) | `SynapseStorageAdapter` + `StorageBackend` pinning | `ctx.synapse` + `synapse_pin` / `synapse_pin_status` agent tools; every node request wallet-signed per operation |

## Composition

`dsh-wallet` is the custody root; the other packages build on it:

```
dsh-wallet  ←  dsh-wallet-ethereum   (registers the evm CryptoAdapter)
    ↑
    ├── dsh-channel-xmtp             (signs XMTP identity per signature)
    └── dsh-storage-synapse          (signs node requests per request)

dsh-treasury                          (independent; needs the storage stack)
```

A typical full install:

```sh
dsh plugin --profile <name> add \
  /path/to/dsh-haven/dsh-wallet \
  /path/to/dsh-haven/dsh-wallet-ethereum \
  /path/to/dsh-haven/dsh-treasury \
  /path/to/dsh-haven/dsh-channel-xmtp \
  /path/to/dsh-haven/dsh-storage-synapse \
  @open-wallet-standard/core @xmtp/node-sdk
```

The two SDKs are optional peers: every package loads, mounts, and tests
without them (lazy imports with actionable errors; tests substitute
`internals.*` seams).

## Prerequisites

- **Storage stack** (`dsh-treasury` only): the profile must mount `storage`,
  `storage-json`/`storage-sqlite`, and `storage-domain` rows (present in
  `dsh-web-app`; absent in `dsh-base`). The treasury patch does NOT insert
  them — a row id inserted by two layers mounts the plugin twice.
- **Agent stack** (`dsh-channel-xmtp` only): agents/sessions/llm, present in
  any agent-running profile.
- Plugins with unmet `inject` lists stay dormant instead of failing, so
  install order is free.

## Custody model (the through-line)

Haven's rule — *the private key never leaves its layer; everything else
requests signatures* — maps to one dsh pattern used everywhere here:

1. Configuration carries **names and credential references** (`keyRef`,
   `dbEncryptionKeyRef`). A pasted raw key fails loud at plugin load because
   key material cannot syntactically be a `CredentialRef`.
2. Secrets exist only **inside one operation**: `ctx.credentials.resolve` runs
   per call, the provider signs, every reference is dropped. Rotation reaches
   the very next operation without restart.
3. Consumers (XMTP signer, Synapse requests, future channels) see only
   **addresses and signatures** through `ctx.wallet`.

## Development

```sh
pnpm install       # workspace of five packages
pnpm vitest        # specs live in <package>/tests/**
```

Each package builds self-contained via `prepare` (tsdown → `lib/`), so git or
path installs work without monorepo context. Money figures are integer µUSD
(USD × 1e6) throughout, matching haven-core.
