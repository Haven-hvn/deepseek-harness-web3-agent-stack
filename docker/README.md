# All-in-one agent containers

Two Docker Hub images are built from this directory:

| Docker Hub Image | Communication Surface | Torrent Clients | Best For |
|---|---|---|---|
| [`havencto/dsh-haven-web3-agent:latest`](https://hub.docker.com/r/havencto/dsh-haven-web3-agent) (`docker/Dockerfile`) | Convos / XMTP (QR invite) + Observatory (`:8787`) | qBittorrent + Transmission | Lightweight headless autonomous agent |
| [`havencto/dsh-haven-mausbot:latest`](https://hub.docker.com/r/havencto/dsh-haven-mausbot) (`docker/Dockerfile.mausbot`) | OpenMausBot Web / Desktop / Mobile GUI (`:8799`) + Observatory (`:8787`) | qBittorrent only | Single-container GUI all-in-one (`wslc`, Docker, Podman — no compose) |

---

## Headless XMTP/Convos image (`havencto/dsh-haven-web3-agent`)

Single fat image: dsh CLI + web3 agent stack + Prowlarr, qBittorrent,
Transmission, ffmpeg, yt-dlp, and the Convos CLI. First boot instantiates
two hot, agent-managed wallets (EVM + ICP) and a testnet-default profile;
every boot starts the supervisor tree and prints a Convos invite QR.

## Run

```sh
podman build -f docker/Dockerfile -t dsh-haven-web3-agent:latest .
podman run -d --name agent \
  -v agent-data:/data \
  -e ACCEPT_HOT_WALLET_RISK=yes \
  -e MODEL_BASE_URL=https://your-openai-compatible-endpoint/v1 \
  -e MODEL_ID=your-model-id \
  -e MODEL_API_KEY=your-key \
  dsh-haven-web3-agent:latest
podman logs -f agent   # instantiation summary, then services, then the QR
```

Publish the dashboard only:

```sh
podman run -d --name agent -p 8787:8787 ...
```

`http://127.0.0.1:8787` is the redacted snapshot. Prowlarr, qBittorrent, and
Transmission stay on localhost. Do not `-p` them.

## First boot

1. Risk gate: refuses to start without `ACCEPT_HOT_WALLET_RISK=yes`.
2. Generates `evm.key` (+ address), `icp.pem`/`icp.seed` (+ principal),
   and the XMTP `inbox.id` into `/data/keys` (0600 secrets). Never rotated,
   never printed. To bring your own EVM key instead, pass
   `-e AGENT_EVM_KEY=0x...` (32-byte hex): it is used as-is, with the
   address and inbox id derived from it; anything else fails the boot
   before writing anything. Ephemeral `-e` only, and clear shell history
   afterwards — env is visible to host inspectors.
3. Writes `/data/dsh/.credentials.yaml` (generated secrets), installs the
   profile from the image skeleton + `profile.patch.yml` user layer, and
   validates it with `dsh --dump-config` before anything starts.
4. Prints addresses, testnet funding pointers, and (once services are up)
   a Convos invite QR. Re-print any time:
   `podman exec agent /opt/agent/convos-qr.sh`.

Delete the volume to start over (new wallets): `podman rm agent`,
`podman volume rm agent-data`. Plugins added into `/data/dsh` by hand are
dropped on the next image upgrade (see below); bake them into the image.

## Upgrading an existing volume

Stack code always comes from the image (`/opt/stack`, linked into the
profile). The profile's **install** (`package.json`, lockfile, `node_modules`
under `/data/dsh/profiles/agent`) and its **user layer** (`cordis.patch.yml`)
are copies made at first boot, so every boot reconciles both with the image:

1. **Install refresh** (`PROFILE_INSTALL_POLICY`, default `auto`). The image
   carries a skeleton id (dsh CLI version + stack lockfile + skeleton
   manifest, `/opt/dsh-skel/.skel-id`). When it differs from
   `/data/.profile-skel-id` — any image upgrade that moves dsh or stack
   versions — the install is replaced from the skeleton. `cordis.patch.yml`
   and `compatibility.json` carry over; sessions, credentials, storages, and
   keys live outside the profile and are untouched. The previous install is
   kept at `/data/dsh/profiles/.agent.bak-<timestamp>` (only the latest).
   Plugins added to the volume by hand are dropped and named in the log.
   `keep` skips the refresh (a dsh upgrade will then likely deny the stale
   bundles).
2. **User-layer refresh** (`PROFILE_PATCH_POLICY`):

| Value | Behavior |
|---|---|
| `auto` (default) | Replace when the installed layer is unmodified since its last install (or predates the stamp file); keep a `.bak-<timestamp>`. An edited layer is left alone with a warning. |
| `keep` | Never touch the installed layer. |
| `replace` | Always replace (with `.bak`). |

A refreshed layer must pass `dsh --dump-config`; otherwise the previous one
is restored and the boot continues. After an install refresh, the combined
result must pass `dsh --dump-config` too; otherwise the previous install is
restored and the container exits (code 3) instead of starting a broken
agent. The image hash last installed is in `/data/.profile-patch.sha256`.

The XMTP channel's outbox (`/data/xmtp/outbox.json`) upgrades in place:
version-1 files load as-is and gain outbound cursors on first write. The
agent gets `stopwaitsecs = 30` so in-flight sends finish and cursors
persist on `podman stop` (use `podman stop -t 35` or more).

## Chat behavior

One conversation runs one agent turn at a time. A message that arrives
mid-turn gets a one-line "still working" ack and its own turn afterwards.
Long jobs run in the background (`run_in_background`) and their results
arrive as unprompted messages when they finish; `tool-jobs` caps
consecutive self-wakes at 3 per conversation (`maxConsecutiveWakes` in
`profile.patch.yml`).

## Testnet defaults

Sepolia, Base Sepolia, Filecoin calibration, Arkiv Rabdi. Royalty
launches have no testnet factory configured (quote/advise work; launches
fail safe). XMTP runs on `production` (messaging, needed by the Convos
app); the Haven-AOL canister stays mainnet (ICP has no public testnet,
reads are free).

## Layout

| Path | Contents |
|---|---|
| `docker/Dockerfile` | fat image build (pinned everything) |
| `docker/entrypoint.sh` | risk gate → keys → profile → validate → profile install + layer refresh → supervisord |
| `docker/keys.mjs` | EVM (viem) + ICP ed25519/principal + XMTP inbox derivation |
| `docker/profile.patch.yml` | user patch layer: model, wallets, testnets, services |
| `docker/supervisord.conf` | prowlarr, qbittorrent, transmission, setup, agent, QR |
| `docker/setup-indexers.mjs` | idempotent public-indexer setup for Prowlarr |
| `docker/convos-qr.sh` | idempotent Convos invite + QR (never fails the boot) |
| `/data` (volume) | keys, dsh home/profile, service data, downloads, logs |

`MODEL_API_PROTOCOL` optionally overrides the wire protocol
(`openai-completions` default; also `openai-responses`,
`anthropic-messages`).

---

## All-in-one GUI image (`havencto/dsh-haven-mausbot` — OpenMausBot + dsh + Prowlarr + qBittorrent)

Built from `docker/Dockerfile.mausbot` and published as a standalone Docker Hub
repository: **`havencto/dsh-haven-mausbot:latest`** (full overview in
`docker/mausbot/README.md`). Bundles the **OpenMausBot Web/Desktop/Mobile GUI**
on top of the Haven web3 `dsh` stack, Prowlarr, qBittorrent, `yt-dlp`, `ffmpeg`,
and Observatory in a **single container** — no `docker compose`, no Transmission,
and no XMTP/Convos (OpenMausBot is the communication surface and sole wallet
owner; works cleanly on `wslc`, plain `docker run`, or `podman run`).

### Run (single command)

```sh
docker run -d --name haven-mausbot \
  --shm-size=512m \
  -p 8799:8799 \
  -p 8787:8787 \
  -v haven-data:/data \
  -e ACCEPT_HOT_WALLET_RISK=yes \
  -e MODEL_BASE_URL=https://your-openai-compatible-endpoint/v1 \
  -e MODEL_ID=your-model-id \
  -e MODEL_API_KEY=your-key \
  havencto/dsh-haven-mausbot:latest

docker logs -f haven-mausbot   # prints wallet addresses and OpenMausBot pairing link
```

Or build locally:

```sh
docker build -f docker/Dockerfile.mausbot -t dsh-haven-mausbot:latest .
```

- **OpenMausBot GUI**: open the one-time sign-in link printed in container logs
  (`http://localhost:8799/pair#code=...`), or mint a fresh code any time with
  `docker exec haven-mausbot openmausbot pair`.
- **Observatory dashboard**: `http://127.0.0.1:8787`.
- **Internal services** (stay container-local, do not `-p` them): Prowlarr
  (`:9696`) and qBittorrent (`:8080`).
- **Pre-wired engine**: OpenMausBot's **Haven Web3 (dsh)** engine runs the
  container's `acp` profile (all 15 web3 plugins, with `acp-stdout-guard.mjs`
  routing plugin logs to stderr so ACP JSON-RPC stays clean).
- **Model configuration**:
  - Pass `MODEL_BASE_URL` + `MODEL_ID` + `MODEL_API_KEY` for any
    OpenAI-compatible endpoint (`spark/<MODEL_ID>`), **or**
  - Pass `-e DEEPSEEK_API_KEY=sk-...` (without `MODEL_BASE_URL`) to run against
    DeepSeek's official API directly, **or**
  - Omit both and configure keys inside OpenMausBot **Settings → AI → Providers**.
- **LAN / remote pairing**: pass `-e OMB_PUBLIC_URL=http://<lan-ip>:8799` so
  printed pairing links and QR codes work from the OpenMausBot desktop/mobile
  apps on your local network (or Tailscale).
- **Volume upgrade**: an existing headless `:latest` `/data` volume upgrades in
  place to `:mausbot` (keeps wallets, downloads, and Prowlarr indexers; adds the
  `acp` profile and seeds `/data/openmausbot/config.json`).

### MausBot variant layout

| Path | Contents |
|---|---|
| `docker/Dockerfile.mausbot` | all-in-one GUI image layered on `ghcr.io/milind-soni/openmausbot:latest` |
| `docker/mausbot/agent.package.json` | minimal helper deps (`viem` only; no `@xmtp/node-sdk`) |
| `docker/mausbot/entrypoint.sh` | risk gate → keys (`--no-xmtp`) → `acp` profile → seed OpenMausBot → `supervisord` under `tini` |
| `docker/mausbot/supervisord.conf` | prowlarr, qbittorrent, setup-indexers, openmausbot, pair-link printer, observatory |
| `docker/mausbot/profile.acp.patch.yml` | ACP profile user layer (testnet wallets, Prowlarr + qBittorrent-only acquisition, web3 plugins) |
| `docker/mausbot/dsh-acp-wrapper.sh` | CLI wrapper for OpenMausBot's `deepseekAgent` driver (loads keys, guards stdout only on ACP runs) |
| `docker/mausbot/acp-stdout-guard.mjs` | routes plugin `console.log` diagnostics to stderr while keeping ACP `process.stdout` pure JSON-RPC |
| `docker/mausbot/seed-openmausbot.mjs` | idempotent first-boot seeder for `/data/openmausbot/config.json` and `/data/keys/model.env` |
| `docker/mausbot/mausbot-pair.sh` | prints the initial OpenMausBot sign-in link + QR once `:8799` is healthy |
