# dsh-storage-synapse

Filecoin Onchain Cloud pinning & Filecoin Pay rail for DeepSeek Harness:
a `ctx.synapse` seam (store / retrieve / pin / pin-status / paymentStatus /
fund over Filecoin Warm Storage) plus four model-facing tools — `synapse_pin`,
`synapse_pin_status`, `synapse_payment_status`, and `synapse_fund` — so any
agent can inspect storage finances, fund Warm Storage from wallet USDFC, and
pin files reliably.

## Signing & Custody (builds on `dsh-wallet`)

There is deliberately no key or credential field in this package's
configuration. `config.wallet` names a `dsh-wallet` entry; a per-operation
`viem` Account delegates `signTransaction`, `signMessage`, and raw EIP-712 /
EIP-2612 `signDigest` through `ctx.wallet` (serialized via `ctx.wallet.withLock`
so concurrent on-chain senders on the same wallet never collide on nonces). No
storage secret exists in configuration, in this package, or in the process
between requests.

## Payment Model (Wallet USDFC vs. Filecoin Pay)

Filecoin Onchain Cloud separates liquid EOA **USDFC** in the agent's wallet
from **Filecoin Pay** contract deposits (gross = locked + free available) and
**Warm Storage** operator approvals. Native FIL/tFIL pays gas only and cannot
substitute for USDFC.

- **Preflight + `autoFund` (default `true` everywhere):** Before uploading
  bytes to any storage provider, `store()` checks gas, Warm Storage approval,
  and Filecoin Pay capacity for the CAR size (`copies`, `withCDN`,
  `autoFundRunwayDays`). When short and wallet USDFC covers the shortfall
  within `maxAutoFundUsdfc`, it approves Warm Storage and deposits USDFC in one
  EIP-2612 permit transaction (`depositWithPermitAndApproveOperator`) before
  uploading. When gas or wallet USDFC is missing, it fails fast *before*
  uploading with exact address, balances, shortfall, and acquisition guidance.
- **Deposit-only:** `synapse_fund` is declarative and idempotent (safe to retry
  after timeouts; never withdraws USDFC out of Filecoin Pay and never swaps
  tokens).

## Install

```sh
dsh plugin --profile <name> add /path/to/dsh-wallet /path/to/dsh-wallet-ethereum /path/to/dsh-storage-synapse
```

## Configuration

```yaml
- id: storage-synapse
  name: 'dsh-storage-synapse'
  config:
    wallet: agent
    rpcUrl: https://api.calibration.node.glif.io/rpc/v1
    networkMode: calibration
    withCDN: true
    copies: 1
    excludeProviderIds: []
    pieceLedgerPath: /data/synapse/pieces.json
    autoFund: true
    maxAutoFundUsdfc: '10'
    autoFundRunwayDays: 30
```

## Model Tools

- `synapse_pin` — upload + pin a local file `path` (returns root CID + CommP
  `pieceCid`), or verify/renew an existing `cid`. Preflights and auto-funds
  Filecoin Pay from wallet USDFC when `autoFund` is enabled.
- `synapse_pin_status` — check live PDP liveness for a pinned CID.
- `synapse_payment_status` — read-only inspection of wallet gas, wallet USDFC,
  Filecoin Pay contract balances (deposited / locked / available), Warm Storage
  approval, runway, and optional per-file upload cost estimate.
- `synapse_fund` — declarative, idempotent Filecoin Pay deposit & Warm Storage
  operator approval (`setup: true`, `targetDepositUsdfc`, `targetRunwayDays`,
  or `path` / `fileSizeBytes`).

## Events

- `synapse/pinned` `{ cid }` — emitted at the commit point of every pin.
- `synapse/funded` `{ address, network, chain, depositedUsdfc, totalDepositedUsdfc, allowancesUpdated, txHash, allowanceTxHash, reason }` — emitted when USDFC is deposited into Filecoin Pay or Warm Storage allowances are updated.

## Piece shape (readers only play single-block)

Every store packs the bytes as a single-raw-block CARv1 (whole file = one
`0x55` block under a tag-42 header root) at every size — a port of
haven-cli's single-block builder without its 32 MiB ceiling. Root CIDs are
raw-codec (`bafkrei…`), never dag-pb; gated records address the CommP piece.
