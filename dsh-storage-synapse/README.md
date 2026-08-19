# dsh-storage-synapse

Synapse pinning for DeepSeek Harness: a `ctx.synapse` seam (store / retrieve /
pin / pin-status over a Synapse/IPFS node) plus two model-facing tools —
`synapse_pin` and `synapse_pin_status` — so the harness itself can natively
choose to pin a file.

Ported from Haven's `SynapseStorageAdapter` + `StorageBackend`
(haven-adapters). Haven's adapter was explicitly a scaffold over the standard
Kubo/IPFS HTTP API (`add`, `cat`, `pin/ls`, `pin/add`); this package keeps
exactly that operation surface.

## Concept transfer

| Haven | Here |
| --- | --- |
| `StorageBackend` machine (`eStoreData` / `ePinRenew` events, op queue) | `ctx.synapse` methods; dsh owns dispatch |
| `StoragePinManager` renewal loop | the agent decides via the `synapse_pin` tool (`pin/add` on a pinned CID renews it) |
| `storageKey: "env:VAR" \| "0x…"` → bearer header | **wallet-signed requests**: each request signs a per-request challenge through `ctx.wallet` |
| `store(bytes) → cid`, `retrieve(cid)`, `checkPin`, `renewPin` | same surface, same `PinStatus` shape (`expiresAt` 0 = permanent, −1 = unpinned) |

## Signing (builds on dsh-wallet)

There is deliberately no key or credential field in this package's
configuration. `config.wallet` names a `dsh-wallet` entry; every node request
mints a canonical challenge (`synapse:<path>:<timestamp>`) and signs it via
`ctx.wallet.signMessage`, which runs dsh-wallet's resolve → load → sign → drop
pipeline. The node verifies signature-over-challenge against the presented
address (`x-synapse-address` / `x-synapse-challenge` / `x-synapse-signature`
headers). No storage secret exists in configuration, in this package, or in
the process between requests.

## Install

```sh
dsh plugin --profile <name> add /path/to/dsh-wallet /path/to/dsh-wallet-ethereum /path/to/dsh-storage-synapse
```

All three are independent bundles; each inserts only its own row. This plugin
stays dormant until the wallet seam is present (`inject: [wallet, tools]`).

## Configuration

```yaml
- id: storage-synapse
  name: 'dsh-storage-synapse'
  config:
    url: 'http://127.0.0.1:5001'   # Synapse/IPFS node HTTP API (Haven's default, standard Kubo address)
    wallet: agent                  # dsh-wallet entry that signs every request (required)
```

## Model experience

- `synapse_pin` — give a local file `path` to upload + pin (returns the CID),
  or an existing `cid` to pin/renew. For anything that must outlive the
  session.
- `synapse_pin_status` — check whether a CID is currently pinned.

## Events

- `synapse/pinned` `{ cid }` — emitted at the commit point of every pin.

## Limitations

- Sign-only authentication headers follow the scheme documented above; a
  plain Kubo node ignores unknown headers, so against unauthenticated local
  nodes the signature is simply extra metadata (matching Haven's scaffold
  behavior, which sent no auth when no key was configured).
- No archival/compression pipeline and no background pin reconciliation — by
  scope, pinning is an agent decision.
