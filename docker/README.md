# All-in-one agent container

Single fat image: dsh CLI + web3 agent stack + Prowlarr, qBittorrent,
Transmission, ffmpeg, yt-dlp, and the Convos CLI. First boot instantiates
two hot, agent-managed wallets (EVM + ICP) and a testnet-default profile;
every boot starts the supervisor tree and prints a Convos invite QR.

## Run

```sh
podman build -f docker/Dockerfile -t dsh-agent:latest .
podman run -d --name agent \
  -v agent-data:/data \
  -e ACCEPT_HOT_WALLET_RISK=yes \
  -e MODEL_BASE_URL=https://your-openai-compatible-endpoint/v1 \
  -e MODEL_ID=your-model-id \
  -e MODEL_API_KEY=your-key \
  dsh-agent:latest
podman logs -f agent   # instantiation summary, then services, then the QR
```

No ports need publishing: Prowlarr/qBittorrent/Transmission bind inside the
container's network namespace for the agent's own tools. Do not `-p` them
unless you put auth in front.

## First boot

1. Risk gate: refuses to start without `ACCEPT_HOT_WALLET_RISK=yes`.
2. Generates `evm.key` (+ address), `icp.pem`/`icp.seed` (+ principal),
   and the XMTP `inbox.id` into `/data/keys` (0600 secrets). Never rotated,
   never printed.
3. Writes `/data/dsh/.credentials.yaml` (generated secrets), installs the
   profile from the image skeleton + `profile.patch.yml` user layer, and
   validates it with `dsh --dump-config` before anything starts.
4. Prints addresses, testnet funding pointers, and (once services are up)
   a Convos invite QR. Re-print any time:
   `podman exec agent /opt/agent/convos-qr.sh`.

Delete the volume to start over (new wallets): `podman rm agent`,
`podman volume rm agent-data`.

## Testnet defaults

Sepolia, Base Sepolia, Filecoin calibration, Arkiv Tiramisu. Royalty
launches have no testnet factory configured (quote/advise work; launches
fail safe). XMTP runs on `production` (messaging, needed by the Convos
app); the Haven-AOL canister stays mainnet (ICP has no public testnet,
reads are free).

## Layout

| Path | Contents |
|---|---|
| `docker/Dockerfile` | fat image build (pinned everything) |
| `docker/entrypoint.sh` | risk gate → keys → profile → validate → supervisord |
| `docker/keys.mjs` | EVM (viem) + ICP ed25519/principal + XMTP inbox derivation |
| `docker/profile.patch.yml` | user patch layer: model, wallets, testnets, services |
| `docker/supervisord.conf` | prowlarr, qbittorrent, transmission, setup, agent, QR |
| `docker/setup-indexers.mjs` | idempotent public-indexer setup for Prowlarr |
| `docker/convos-qr.sh` | idempotent Convos invite + QR (never fails the boot) |
| `/data` (volume) | keys, dsh home/profile, service data, downloads, logs |

`MODEL_API_PROTOCOL` optionally overrides the wire protocol
(`openai-completions` default; also `openai-responses`,
`anthropic-messages`).
