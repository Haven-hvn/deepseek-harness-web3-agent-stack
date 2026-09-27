# Read-only agent dashboard (fat container)

Status: plan only. No runtime code in this directory.

The product is the snapshot. The page is a table viewer for that JSON. No chart library, no design system, no warehouse, no DuckDB, no ETL job. Backend code records the right facts. A few dozen lines of HTML dump them.

## Shape

One image, one volume, one published port (`8787`). qBittorrent `:8080`, Prowlarr `:9696`, and Transmission `:9091` stay on `127.0.0.1`.

Cordis events exist only inside `dsh --profile agent`. A sibling process cannot subscribe. So:

1. `dsh-observatory` runs in the agent. It copies facts it is allowed to see into `/data/observatory/snapshot.json` and appends the same rows to `events.jsonl`.
2. `dashboard` is a supervisord program that reads that directory and serves it. It does not import wallet code, viem, or qBit. If it dies, the agent keeps running.

The reader never opens `/data/keys`, `.credentials.yaml`, the qBit WebUI, or Prowlarr.

## What to record

Treasury is a survival engine (`funded` / `low` / `critical` / `depleted`, integer µUSD). It is not the business ledger. Do not put revenue in `recordExpense`. The observatory writes its own rows. Money is µUSD everywhere, same as `dsh-treasury`.

Each row is a flat object: `ts`, `kind`, and the fields below. No joins, no second database. The snapshot is the latest row per key plus the raw log for history. History is the log. Retention is "rotate the file", not a pipeline.

### Health

From supervisord socket (`/data/supervisor.sock`, already mode 0700) and localhost version checks the agent already knows (`qbittorrent.ts` `health()`, Transmission RPC, Prowlarr `/api/v1/health` if present):

- program name, state, last exit, uptime
- qBit and Transmission: torrent count by state (`queued`, `downloading`, `completed`, `failed`), `dlSpeed`, `upSpeed`, `bytesDone`, `bytesLeft`
- no name, path, magnet, hash, or indexer title on the public snapshot

### Wallet and treasury

Already in process, not on a bus a sibling can read:

- `TreasuryReport`: state, `totalValueUsd`, `dailyBurnUsd`, `runwayDays`, budget, balances `{chain, token, amount, usdEstimate}`, recent expenses
- `treasury/expense` and `treasury/state-changed` (copy them; do not change the policy matrix)
- `wallet/signed` is address + operation only. Keep it that way
- `get_balances` is a tool, not a series. Emit `wallet/balances` after a refresh: chain, token, amount, usd, address. Container `tokens: []` today, so native balances first, ERC-20 when configured

Cost rows use the existing categories: `inference`, `tools`, `infrastructure`, `storage`, `messaging`, `reserve`.

### Token meter

`@deepseek-ai/dsh-token-meter` has no events in this repo. Policy already prices `measure(session).totalTokens`. Record that number next to the inference expense: `tokens`, `usd`, `model` if the session exposes it. No prompt text.

### Acquisition

`/data/downloads/acquire/acquisition-handles.json` has `handle`, `state`, `progress`, `files[].path`. Public row is handle, state, progress, byte size, backend. Paths and names are dropped in the collector, not hidden in the page.

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
| acquire | JSON file with paths | `acquire/updated` without path or name |
| royalty launch / sweep | tool return only | `rr/launched`, `rr/swept` |
| AOL gate | tool + decrypt event | copy `GateSummary`; sale row only if a caller has one |
| file ↔ token | absent | `catalog/upsert` with cid, gate kind, token |
| DataDAO | absent | a gate kind on that row, not a new protocol |

## Reader

`GET /snapshot` returns the JSON. `GET /health` returns the health section. The HTML page is one file: a heading per section and a `<table>` or `<pre>` per array. Time series is the log rendered as rows (ts, kind, amount), not a chart. Filters are query params on the JSON (`?kind=cost&token=0x…`), implemented in the reader with `Array.filter`, not a query engine.

No login in v1. Public means the redacted snapshot, not a second projection.

## Image wiring (when built)

- Package on the workspace, Dockerfile `COPY` list, and `dsh plugin add`. First boot does not re-patch an existing volume after `/data/.instantiated`.
- `[program:dashboard]` priority 50 in `docker/supervisord.conf`. `EXPOSE 8787`. README: publish 8787 only.

## Out of scope

- GUI work beyond tables.
- A warehouse, DuckDB, Parquet, or a metrics stack.
- A second container.
- Booking revenue inside treasury policy.
- DataDAO contracts, a keeper, or serving file bytes on this port.
- Prompts, XMTP bodies, magnets, torrent names, keys.
