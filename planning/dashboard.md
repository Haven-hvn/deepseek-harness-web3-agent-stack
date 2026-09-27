# Read-only agent dashboard (fat container)

Status: implemented in `dsh-observatory` and `[program:dashboard]`. This file is the map, not the runtime.

The product is the snapshot. The page is a table viewer for that JSON. No chart library, no design system, no warehouse, no DuckDB, no ETL job. Backend code records the right facts. A few dozen lines of HTML dump them.

## Shape

One image, one volume, one published port (`8787`). qBittorrent `:8080`, Prowlarr `:9696`, and Transmission `:9091` stay on `127.0.0.1`.

Cordis events exist only inside `dsh --profile agent`. A sibling process cannot subscribe. So:

1. `dsh-observatory` runs in the agent. It appends ledger rows to `/data/observatory/events.jsonl`. Live panels are filled by reading the owning component when the page asks, not from that log.
2. `dashboard` is a supervisord program that reads that directory and serves it. It does not import wallet code, viem, or qBit. If it dies, the agent keeps running.

The reader never opens `/data/keys`, `.credentials.yaml`, the qBit WebUI, or Prowlarr.

## What to record

Treasury is a survival engine (`funded` / `low` / `critical` / `depleted`, integer µUSD). It is not the business ledger. Do not put revenue in `recordExpense`. The observatory writes its own rows. Money is µUSD everywhere, same as `dsh-treasury`.

Two stores, not one log of everything.

**Ledger** (`events.jsonl`): append only facts whose past values are the analytic. A row is `ts` plus the fields below. Retention is "rotate the file".

**Live**: overwritten or read at request time from the component that already owns it. No history. Download progress is the example. qBit, Transmission, and `acquisition-handles.json` are the source. The panel asks them (or a one-row cache the collector refreshed from them). It does not append `progress: 0.4`.

### Health and downloads (live)

Read when asked. Do not append.

- supervisord socket (`/data/supervisor.sock`, mode 0700): program, state, uptime
- qBit and Transmission, the same localhost calls the agent already makes (`qbittorrent.ts` `health()`, Transmission RPC): counts by state, speeds, progress, bytes left
- acquire handles: state and progress only

No name, path, magnet, hash, or indexer title on the public response. The reader still does not hold qBit credentials; the collector performs that read and returns the redacted object. It does not keep the previous one.

### Wallet and treasury

Already in process, not on a bus a sibling can read:

- `TreasuryReport`: state, `totalValueUsd`, `dailyBurnUsd`, `runwayDays`, budget, balances `{chain, token, amount, usdEstimate}`, recent expenses
- `treasury/expense` and `treasury/state-changed` (copy them; do not change the policy matrix)
- `wallet/signed` is address + operation only. Keep it that way
- `get_balances` is a tool, not a series. Emit `wallet/balances` after a refresh: chain, token, amount, usd, address. Container `tokens: []` today, so native balances first, ERC-20 when configured

Cost rows use the existing categories: `inference`, `tools`, `infrastructure`, `storage`, `messaging`, `reserve`.

### Token meter

`@deepseek-ai/dsh-token-meter` has no events in this repo. Policy already prices `measure(session).totalTokens`. Record that number next to the inference expense: `tokens`, `usd`, `model` if the session exposes it. No prompt text.

### Launches and revenue

`dsh-royalty-router` returns SDK JSON and stores nothing. Without new events there is no ROI.

- `rr/launched`: chain, token, symbol, tx, factory, seed µUSD if the call knows it
- `rr/swept`: token, tx, amount µUSD
- revenue row: `stream` (`royalty` | `gate` | `other`), amount, token or cid

Factory is unset in `docker/profile.patch.yml`. Zero launches is a valid snapshot.

ROI is arithmetic on rows that share a token id: revenue − acquire − pin − inference − chain fees. Untagged spend stays on the category list and off the launch row. The collector does not infer a match.

### Files and gates

No DataDAO type exists. Do not invent a chain stack for the dashboard. A file row is:

- cid, byte size, pin status (`synapse` `PinStatus`: provider, expiresAt, redundancy)
- acquire µUSD, pin µUSD, inference µUSD, if the tool passed a cid
- gate: `none` | `aol` | `nft` | `memecoin` | `datadao`
- token, chain, threshold or price, holder or buyer count, revenue µUSD

`dsh-haven-aol` already has `GateSummary` (`version`, `cid`, `chain`, `tokenAddress`, `threshold`, market-cap fields) and `aol/decrypted` (cid + bytes, no keys). Copy the summary. Sale counts are a new `aol/sale` or `catalog/upsert` only when some caller actually knows a buyer paid. Do not fake holders from chain in v1.

`dsh-haven-pipeline` is not in the image. Ignore it until it is.

`dsh-arkiv` emits `arkiv/created` with payload bytes. Do not copy the payload. Key, owner, contentType, tx are enough.

`dsh-erc8004` already emits `erc8004/registered` (`agentId`, `tokenUri`, tx, owner). That is the agent's own identity row, separate from file tokens.

### What is missing and must be emitted

| Source | Today | Add |
|---|---|---|
| treasury expense / state | events exist | copy |
| wallet balances | tool only | `wallet/balances` |
| token meter | in-process measure | record beside inference cost |
| acquire | JSON file with paths | live read, drop path and name. no event |
| royalty launch / sweep | tool return only | `rr/launched`, `rr/swept` |
| AOL gate | tool + decrypt event | copy `GateSummary`; sale row only if a caller has one |
| file ↔ token | absent | `catalog/upsert` with cid, gate kind, token |
| DataDAO | absent | a gate kind on that row, not a new protocol |

## Panels

The page is these panels and nothing else. No derived visuals beyond a sum or a ratio the row already has (`runwayDays`, ROI). A `24h` / `7d` / `30d` control applies only to ledger panels.

| Panel | Source | History |
|---|---|---|
| Status | supervisord socket, localhost health checks | no. up/down and uptime now |
| Downloads | qBit WebUI, Transmission RPC, acquire handles | no. counts, states, speeds, progress now. No names |
| Treasury | `TreasuryReport` | no for the pill (state, runway, total). burn history is the Burn panel |
| Balances | `get_balances` / wallet | yes. append on change, not on a timer. level over time is the treasury chart |
| Burn | `treasury/expense` | yes. category, µUSD, ts. Cost Explorer panel |
| Tokens | token meter beside inference expense | yes. token count and µUSD |
| Revenue | royalty sweep, gate sale | yes. stream, amount, token or cid |
| Launches | `rr/launched` plus ledger rows with the same token | the launch is an event. ROI is a sum of ledger rows, not a stored series |
| Catalog | current file, pin, and gate records | no for pin progress and gate config. yes for sales already on the Revenue panel |

Do not store: download progress, speeds, process state, pin progress, prompt text, torrent names. Read those from the component that has them.

## Reader

`GET /snapshot` returns the JSON. `GET /health` returns the health section. The page imports one existing component set (a CDN table and a line chart is enough) and points each panel at a snapshot array. No custom CSS beyond that import, no design system, no hand-built charts.

Filters are query params (`?kind=cost&since=7d&token=0x…`) applied with `Array.filter` in the reader. Not a query engine.

No login in v1. Public means the redacted snapshot, not a second projection.

## Image wiring (when built)

- Package on the workspace, Dockerfile `COPY` list, and `dsh plugin add`. First boot does not re-patch an existing volume after `/data/.instantiated`.
- `[program:dashboard]` priority 50 in `docker/supervisord.conf`. `EXPOSE 8787`. README: publish 8787 only.

## Data map

Money is integer µUSD. Addresses, token contracts, and tx hashes are full and linked to a block explorer. No truncated address. No prompt, tool argument, tool output, XMTP body, magnet, torrent name, path, or hash.

A row is either **live** (read now, not stored) or **ledger** (append to `events.jsonl`). The reader never calls qBit, Transmission, RPC, or the wallet. The collector does.

### Status

| Point | Store | Source | On the panel |
|---|---|---|---|
| program, state, uptime | live | supervisord socket `/data/supervisor.sock` | one row per program |
| qBit up | live | localhost health the agent already calls | up/down |
| Transmission up | live | Transmission RPC | up/down |
| Prowlarr up | live | collector localhost check; reader still has no Prowlarr client | up/down |
| agent up | live | supervisord `agent` state | up/down |
| XMTP status | live | latest `xmtp/status` kept in the live file only | connected/not, reason. No message |

### Downloads

| Point | Store | Source | On the panel |
|---|---|---|---|
| count by state | live | qBit WebUI + Transmission RPC | table |
| speed, progress, bytes left | live | same | table. No name, path, magnet, hash |
| acquire state, progress | live | `acquisition-handles.json`, path and name dropped | table |

Not appended. A refresh overwrites the live file.

### Treasury

| Point | Store | Source | On the panel |
|---|---|---|---|
| state, totalValueUsd, dailyBurnUsd, runwayDays, budget | live | `TreasuryReport` via `treasury/state-changed`, else last report the collector saw | pill. Not a chart |
| state transitions | ledger | copy `treasury/state-changed` (`previous`, `current`, ts) | not a panel. Feeds the pill's "since" |

### Balances

| Point | Store | Source | On the panel |
|---|---|---|---|
| chain, token, amount, usd, address | ledger | new `wallet/balances`, emitted when `get_balances` or `updateBalances` changes a figure. Not on a timer | line chart + table. Explorer link on the address |
| native first | ledger | container `tokens: []` today | ERC-20 only when configured |

### Burn

| Point | Store | Source | On the panel |
|---|---|---|---|
| category, amount µUSD, token, ts | ledger | copy `treasury/expense`. Categories already exist: inference, tools, infrastructure, storage, messaging, reserve | table + line chart. `24h/7d/30d` |
| description | drop | expense may contain one | never on the snapshot |

### Tokens

| Point | Store | Source | On the panel |
|---|---|---|---|
| tokens, usd, model | ledger | token-meter `measure(session).totalTokens` written beside the inference expense. No prompt | table + line chart |

### Revenue

| Point | Store | Source | On the panel |
|---|---|---|---|
| stream, amount µUSD, token or cid, tx | ledger | `rr/swept` → stream `royalty`. A sale row only when a caller knows a buyer paid (`aol/sale` or `catalog/upsert`). Do not invent holders | table + line chart. Explorer link on tx and token |
| factory unset | — | `docker/profile.patch.yml` | empty panel is valid |

### Launches

| Point | Store | Source | On the panel |
|---|---|---|---|
| chain, token, symbol, tx, factory, seed µUSD | ledger | new `rr/launched`. Tool return only today | table. Explorer links |
| ROI | computed | sum of ledger rows that already share that token: revenue − acquire − pin − inference − fees. Untagged spend stays on Burn | one number per launch. Not a stored series |
| wallet/signed | not copied | address + operation only, and it is not a launch | omit |

### Catalog

| Point | Store | Source | On the panel |
|---|---|---|---|
| cid, pin provider, expiresAt, redundancy | live | `synapse/pinned` plus `PinStatus` from `checkPin` when the page asks | table. Pin progress is live |
| gate kind, token, chain, threshold, price | live | `GateSummary` from `aol_gate_info`: `none \| aol \| nft \| memecoin \| datadao`. DataDAO is this field, not a protocol | table. Explorer link on the token |
| acquire / pin / inference µUSD | ledger | only if the tool passed a cid. Collector does not match by guess | columns, summed from ledger |
| sales | ledger | Revenue panel. Not a second series | link, not a copy |
| arkiv payload | drop | `arkiv/created` has payload bytes | key, owner, contentType, tx only, if shown at all |
| agent identity | live | `erc8004/registered`: agentId, tokenUri, tx, owner | one identity row, separate from file tokens. Explorer link |
| decrypted bytes | drop | `aol/decrypted` is cid + bytes | cid only, and only if a catalog row already exists |

### Not on the page

Traces, prompts, tool arguments, tool output, XMTP bodies, torrent names, magnets, paths, hashes, keys, `.credentials.yaml`, qBit WebUI credentials.

## Out of scope

- GUI work beyond tables.
- A warehouse, DuckDB, Parquet, or a metrics stack.
- A second container.
- Booking revenue inside treasury policy.
- DataDAO contracts, a keeper, or serving file bytes on this port.
- Prompts, XMTP bodies, magnets, torrent names, keys.
