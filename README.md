# dsh-web3

## Quickstart

One-shot get-started (builds latest `02ca906` stack, tests, starts `xmtp-prod`, spits QR + wallet):

```sh
bash quickstart.sh
# or: MUSE_SPARK_API_KEY=<your-key> bash quickstart.sh
```

Spits `Invite URL: https://popup.convos.org/v2?i=...` + ANSI QR (`qrencode -t ANSIUTF8`) and wallet `0xa85dD3FbD8C2c831Ef156036F14638CcFf03b44e` (dynamic `wallet_info`→`ctx.wallet.address`). Also available: `./show-convos-qr.sh` / `./show-xmtp-qr.sh` for QR-only.


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
| [`dsh-wallet-tools`](./dsh-wallet-tools) | wallet address/balance exposure (replaces hard-coded persona) | `wallet_info` tool via `ctx.tools` + `ctx.wallet.address()` live (no hard-coded `0x...`) |
| [`dsh-persona`](./dsh-persona) | Haven persona / system instructions | `agent/request` composition; generic instruction to call `wallet_info` when address/balance/funding asked |

## Composition

`dsh-wallet` is the custody root; the other packages build on it:

```
dsh-wallet  ←  dsh-wallet-ethereum   (registers the evm CryptoAdapter)
    ↑
    ├── dsh-channel-xmtp             (signs XMTP identity per signature)
    ├── dsh-storage-synapse          (signs node requests per request)
    └── dsh-wallet-tools             (exposes wallet_info via ctx.tools → ctx.wallet)
dsh-persona                           (composes agent/request; calls wallet_info, no hard-coded address)
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

## Design decision: isolated bundles, coupled seams

Web3 plugins are **isolated as code, coupled at the seam** — a direct consequence of
how the DeepSeek harness composes.

* **Isolated** — every package is a standalone Cordis plugin (`export const name`,
  `export const inject`, `export function apply(ctx, config)`) with its own
  `dsh.bundle.patch` → `cordis.patch.yml`. There is no aggregate bundle; `dsh plugin add`
  installs one capability at a time and `inject` ordering is free (unmet `inject` stays
  dormant). This is why `dsh-wallet`, `dsh-channel-xmtp`, `dsh-storage-synapse`,
  `dsh-treasury`, and `dsh-wallet-tools` each build via `prepare` (tsdown → `lib/`) and test
  without the others (`internals.*` seams).

* **Coupled at the seam** — isolation would break without declared contracts:
  `ctx.wallet` (custody), `ctx.tools` (model-facing tools), `ctx.agents`/`ctx.sessions`
  (per-conversation agents), `ctx.synapse`/`ctx.treasury` (storage). Plugins declare
  this with `inject` — e.g. `inject = ['wallet','tools']` in `dsh-wallet-tools` and
  `dsh-storage-synapse` — so they mount only when the seam exists, and call it
  per-operation (`ctx.wallet.address()`, `ctx.wallet.signMessage()`, `ctx.tools.register(defineTool(...))`).

Harness limitations that force this shape:

1. **Singleton tool runtime.** `@deepseek-ai/dsh-tools` exposes one scheduler (`ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare`). If two instances are deduped incorrectly the `Symbol` mismatches and every `tool/call` fails with `Cannot read properties of undefined (reading 'prepare')`. Bundles therefore depend on `dsh-tools` as a **peer** (`==0.1.0-rc.7`) and `link:` installs must dedupe to one copy.

2. **Wallet custody is per-operation.** Configuration carries only `keyRef`/`wallet` names; `ctx.credentials.resolve` runs inside `signMessage`/`address` and is dropped. Consumers (XMTP identity in `dsh-channel-xmtp`, per-request `x-synapse-*` headers in `dsh-storage-synapse`, `wallet_info` in `dsh-wallet-tools`) see only addresses/signatures. Hard-coding an address in persona (`When asked for address, answer with 0x...`) breaks rotation and wallet-agnostic installs — the correct seam is a tool that resolves `ctx.wallet.address(config.wallet)` live.

3. **Channel is per-conversation, not per-process.** `dsh-channel-xmtp` creates one `ctx.agents` session per XMTP conversation (`SessionId` derived from `conversationId`), handles `conversations.sync()` before `getConversationById`, reconnect/consent sweep, and dedup. The channel owns transport; the agent owns the turn.

Result: add `dsh-wallet` once, then compose any subset. `dsh-wallet-tools` (`wallet_info` tool, `presentCall: {kind:'read'}`) makes the EVM address model-reachable without persona shortcuts; `dsh-channel-xmtp` makes it XMTP-reachable; `dsh-storage-synapse` makes it storage-reachable — all through `ctx.wallet`, none by sharing key material.

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
