# dsh-haven-pipeline

Read-only Haven CLI bridge for DeepSeek Harness: exposes `haven` entity / download-status / jobs **reads** as model-facing tools. Permanent survival layer — writes are never bridged.

## Tools

| Tool | Haven command | Kind |
|---|---|---|
| `haven_entity_get` | `haven entity get <key> --json` | read |
| `haven_entity_query` | `haven entity query '<filter>' --json --limit N` | read |
| `haven_download_info` | `haven download info <cid> --json` | read |
| `haven_jobs_list` | `haven jobs list` (+ `--status`) | read |

All four are `presentCall: {kind:'read'}` — free reads, never gated, never metered.

## What is deliberately absent

`upload file`, `download cid`, `jobs run/create`, `run daemon` — anything that signs or spends. Those port natively to `ctx.wallet` + `ctx.synapse` + `ctx.arkiv` (viem `toAccount` delegating to OWS, same pattern as `dsh-storage-synapse`), never via subprocess with `HAVEN_PRIVATE_KEY` in env.

## Config

```yaml
- id: haven-pipeline
  config:
    havenBin: haven          # resolved via PATH; override for venv absolute path
    configFile: ~/.config/haven/config.toml  # optional --config passthrough
    bridgeTimeoutMs: 60000   # per-call spawn timeout
```

`inject = ['tools']` only. No wallet, no treasury, no credentials — the bridge holds no secrets.

## Custody note

Read commands construct an Arkiv client with `NamedAccount.from_private_key` even for queries (`entity.py:81`), so `HAVEN_PRIVATE_KEY` must exist in the **Python process env** where `haven` runs. The bridge never passes a key: it inherits the ambient env of the dsh process. Keep a read-capable key (or dummy for public queries) in the shell that starts the profile — never in `cordis.patch.yml`, never in tool args.
