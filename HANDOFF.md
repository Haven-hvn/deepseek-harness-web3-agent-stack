# Agent Handoff: all-in-one dsh web3 agent container (docker/)

## Goal
Single fat Docker image (`localhost/dsh-web3-agent:latest`) that boots a full dsh
agent: hot internal EVM+ICP wallets, testnet defaults, user-provided
`MODEL_BASE_URL`/`MODEL_ID`, Prowlarr + qBittorrent + Transmission + yt-dlp +
ffmpeg inside, Convos/XMTP QR output. Build context = this repo,
`docker/Dockerfile`.

## Where things stand (2026-09-27, main @ b61983d + unpushed CI fix)
- Prowlarr URL split, dsh-tool-acquisition arm, dsh-arkiv chain fix: done,
  tested, pushed.
- `docker/` context exists and is pushed. Image builds were green until the
  runtime test showed ALL 13 `link:` bundles "failed to import".
- Root cause found: the Dockerfile never built the stack (`lib/` is
  dockerignored, no install/build step). Fix committed (cb67d8b): install +
  `pnpm -r build` + `pnpm prune --prod` in-image.
- Two `file:` deps escape the build context and are now satisfied by pinned
  git clones (committed, b61983d):
  - `dsh-haven-aol` → `file:../../haven-aol/packages/typescript`
    = `/opt/haven-aol`, `HAVEN_AOL_REF=29327ae8` (= haven-aol origin HEAD,
    matches local checkout). Built with `npm ci` (its pnpm lock is stale).
  - `dsh-royalty-router` → `file:../../mint-glue-graduate/sdk`
    = `/opt/mint-glue-graduate`, `ROYALTY_REF=5f8b8b79` (= origin HEAD,
    matches local checkout). Also `npm ci`.
  - These are the ONLY `file:`/`link:` deps in the workspace (verified by
    grep) — no more whack-a-mole expected.
- `tsconfig.base.json` added to the workspace-root COPY (packages extend it).
- Latest uncommitted change at handoff time: `ENV CI=true` (pnpm prune
  aborts without TTY otherwise). Should be committed by the time you read this.

## In-flight / next action
A clean `podman build` was running when this handoff was written. Managed
background builds DIE with the spawning session — assume it died and re-run:

```bash
cd /root/deepseek-harness-web3-agent-stack
podman build --network=host -f docker/Dockerfile -t dsh-web3-agent:latest . 2>&1 | tail -3
```

`--network=host` is REQUIRED (bridge has no DNS/egress on this box).
Then boot-test:

```bash
podman volume create agent-test-data
podman run -d --name agent-test --network=host -v agent-test-data:/data \
  -e ACCEPT_HOT_WALLET_RISK=yes \
  -e MODEL_BASE_URL=https://example.invalid/v1 -e MODEL_ID=test-model \
  -e MODEL_API_KEY=dummy-key localhost/dsh-web3-agent:latest
sleep 60
podman exec agent-test cat /data/logs/agent.err.log   # want: NO "failed to import"
podman exec agent-test ls -la /data/xmtp/             # want: agent.db present
podman exec agent-test tail -5 /data/logs/convos-qr.out.log  # want: QR output
```

Build-time gates already in the Dockerfile: `dsh --dump-default-config` +
a node import check of dsh-wallet + dsh-tool-acquisition.

## Gotchas (learned the hard way)
- `podman build ... | tail` hides failure: check `${PIPESTATUS[0]}`.
- pnpm at RUNTIME is impossible: the /data volume is a different filesystem
  from the image pnpm store, which pnpm refuses. Entrypoint therefore
  re-links profile symlinks with `ln -sfn` directly — do not reintroduce
  runtime `dsh plugin add`.
- Runtime bundle deps resolve via `/opt/stack/node_modules` (workspace
  install kept in-image, dev-deps pruned). Entrypoint relink loop is still
  needed for the profile's top-level `dsh-*` links.
- Test boots need `--network=host` AND host services on 9696/8080/9091
  stopped (conflict with in-container Prowlarr/qbit/transmission).
- DISK: box is 50G, builds pile up fast (hit 99% once → `storing layer:
  read/write on closed pipe`). After a green build: `podman system prune -a -f`
  will delete the image too — re-tag or rebuild after. Check `df -h` before
  each build; keep one good image, prune the rest (`podman image prune -f`
  keeps tagged images — prefer that).
- qBittorrent needs `adminadmin` login (403 until then); Transmission 409 is
  its normal session handshake; use 127.0.0.1 not localhost (::1 refused).
- RuTracker 403 / 1337x+EZTV Cloudflare: expected indexer noise, not fatal.

## Done criteria for the container milestone
1. `podman build` exits 0.
2. Fresh boot: keys generated, profile valid, indexers OK (setup-indexers
   exit 0), zero "failed to import", `/data/xmtp/agent.db` exists, QR
   printed to convos-qr log.
3. Cleanup: stop/rm agent-test, rm volume, prune dangling images, `df -h`
   back under ~80%.
4. Commit + push.
