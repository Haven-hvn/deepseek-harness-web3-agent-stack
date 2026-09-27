# dsh-tool-acquisition

Download/acquisition tools for DeepSeek Harness: the missing arm between
`prowlarr_search` and `synapse_pin`. Turns one submit call — a magnet
link, a direct http(s) URL, or a Prowlarr release reference — into local
files, then lets the agent poll the handle to completion.

Ported from Haven CLI's `acquisition/` package plus the Prowlarr plugin's
fetch strategy (`_acquire`/`_submit`/`_wait`), with the clients outsourced:
torrents download in qBittorrent/Transmission (daemons beside Prowlarr),
while the agent stays a thin poller. There is deliberately no in-process
torrent engine and no Usenet backend.

## Tools

| Tool | Kind | Purpose |
|---|---|---|
| `<prefix>_submit` | execute | Download one source; returns an opaque handle + first state |
| `<prefix>_status` | read | Poll a handle; finalizes (select + import) on completion |

Submit takes exactly one source: `magnet`, `url`, or Prowlarr
`downloadUrl`/`magnetUrl` (the redacted form from `prowlarr_search` is
fine — the API key is re-attached server-side and never shown to the
model). `waitMs` bounds the inline wait (default 30s); past the budget
the call returns `queued`/`downloading` and the agent polls
`<prefix>_status`. Handles persist in
`<downloadDir>/acquisition-handles.json`, so a poll after a restart
still resolves, and terminal states replay their stored result.

Resolution order per submit:

1. magnets and `.torrent` bodies → torrent clients in `torrentClients`
   order, failing over unless the error is permanent
2. direct URLs and Prowlarr bodies sniffing as content → guarded fetch,
   type check, import
3. `.nzb` bodies → refused (`ACQUIRE_UNSUPPORTED`; no Usenet backend)

Exactly-once: every record carries a content key (torrent infohash, hashed
URL, hashed release ref), so resubmitting the same source resolves to its
handle — refreshed from the backend — instead of queueing twice. Failover
verifies before trying the next backend: an ambiguous submit error
(timeout, reset, 5xx) probes the first backend by infohash, adopting the
torrent when it queued and failing over only when it provably did not (a
backend that cannot answer either yields an uncertain record plus an
ambiguous error — poll `<prefix>_status`, never resubmit elsewhere).
Failed/missing records stay retryable under a new handle.

## Configuration

```yaml
- id: tool-acquisition
  name: 'dsh-tool-acquisition'
  config:
    prowlarrUrl: http://localhost:9696   # $PROWLARR_URL fallback
    # prowlarrApiKey: ...                # or $PROWLARR_API_KEY (server-side only)
    qbittorrentUrl: http://localhost:8080
    # qbittorrentPassword: ...           # or $QBITTORRENT_PASSWORD
    transmissionUrl: http://localhost:9091
    downloadDir: ./downloads-acquisition # spool + imports + handle store
    allowPrivateHosts: false             # true for LAN indexers / tests
    accept: ['*']                        # kinds, '*', or MIME globs; empty = all
    selectMode: all                      # or 'largest'
    importMode: hardlink                 # copy | move | inplace
```

`inject = ['tools']` only. No wallet (downloads are free), no treasury.
Client passwords fall back to `$QBITTORRENT_PASSWORD` /
`$TRANSMISSION_PASSWORD`; every error message is redacted.

## Guardrails (Haven parity)

- Every fetch hop — including each redirect — is SSRF-checked (scheme,
  `allowedHosts`, public-address resolution); redirects never carry
  credentials off-origin, and the Prowlarr key is sent as an
  `X-Api-Key` header to the Prowlarr origin only.
- Bodies stream to `.part` files with a hard byte cap and atomic
  rename; saved files get an extension matching sniffed content.
- Completed downloads are filtered by content-sniffed type/size/name
  (`accept`/`reject`, sample/`.nfo`/temp exclusions) and imported via
  hardlink (default), copy, move, or inplace, with `remote=local`
  path mappings for clients on other filesystems.

## Tests

```sh
pnpm vitest run   # or: pnpm --filter dsh-tool-acquisition test
```

Fake `node:http` servers stand in for Prowlarr, qBittorrent, and
Transmission; tools are also exercised through a real Cordis tool
registry mount.
