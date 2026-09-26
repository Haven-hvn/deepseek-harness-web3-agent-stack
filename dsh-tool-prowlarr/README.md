# dsh-tool-prowlarr

Read-only [Prowlarr](https://prowlarr.com) tools for DeepSeek Harness. The agent can
discover the indexers configured in a Prowlarr instance and search them through the
Prowlarr v1 API. The package is use-case agnostic: which indexers, categories, and
result sizes a deployment uses is configuration (see `examples/arxiv.patch.yml`).

## Tools

| Tool | Purpose |
| --- | --- |
| `<prefix>_indexers` | List indexers: id, name, protocol, enabled, privacy, supported search types, top-level Newznab categories. Args: `nameContains?`, `includeDisabled?` |
| `<prefix>_search` | `GET /api/v1/search`. Args: `query` (required), `indexerIds?`, `categories?`, `type?` (`search`/`tvsearch`/`movie`/`music`/`book`), `limit?`, `offset?` |

`<prefix>` defaults to `prowlarr`. Both tools return a typed canonical value (usable
from PTC mode as `await tools.prowlarr_search({...})`) and render a compact text list
for the model. Nothing is grabbed or downloaded.

## Install

```sh
dsh plugin --profile <name> add /path/to/dsh-tool-prowlarr
export PROWLARR_API_KEY=...        # Prowlarr → Settings → General → Security
```

## Configuration

```yaml
- id: tool-prowlarr
  config:
    baseUrl: http://localhost:9696   # or $PROWLARR_URL; include any URL base
    # apiKey: !!js process.env.PROWLARR_API_KEY   # defaults to $PROWLARR_API_KEY
    toolPrefix: prowlarr
    defaultIndexerIds: []            # used when a call names none; empty = all enabled
    defaultCategories: []            # used when a call names none
    defaultSearchType: search
    defaultLimit: 25
    maxLimit: 100                    # hard cap on results returned per call
    timeoutMs: 60000                 # per request; searches fan out to indexers
    allowedIndexerIds: []            # non-empty = the only indexers listable/searchable
```

A patch replaces a row's whole `config`, so restate every key you rely on.
Mount the plugin twice with different `id`s and `toolPrefix`es to expose two
Prowlarr instances or two scoped views of one.

## Behavior notes

- Prowlarr applies `limit` per indexer; the plugin enforces the final bound and
  reports `total` and `truncated`.
- An `allowedIndexerIds` list with no explicit selection searches exactly the
  allowlist, never "all indexers"; requesting an id outside it is a tool error.
- Errors are `ProwlarrError` with a `code`: `PROWLARR_NOT_CONFIGURED`,
  `PROWLARR_INVALID_REQUEST`, `PROWLARR_UNAUTHORIZED`, `PROWLARR_HTTP_ERROR`,
  `PROWLARR_NETWORK_ERROR`, `PROWLARR_BAD_RESPONSE`, `PROWLARR_TIMEOUT`, `PROWLARR_ABORTED`.

## Security

- The key is sent only in the `X-Api-Key` header; redirects are refused.
- Prowlarr rewrites `downloadUrl`/`magnetUrl` into proxy links containing
  `apikey=<key>`. The plugin strips that parameter and any literal key from every
  returned URL, guid, and error message before the model sees it.
- Indexer content is third-party data; the rendered output tells the model to treat
  it as untrusted.

## Development

```sh
pnpm install
pnpm typecheck && pnpm test && pnpm build
```

Tests run the tools through the real `dsh-tools` registry against a local fake
Prowlarr HTTP server.
