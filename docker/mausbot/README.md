# Haven Web3 Agent + OpenMausBot GUI (`havencto/dsh-haven-mausbot`)

All-in-one single-container image bundling the **OpenMausBot Web / Desktop / Mobile GUI**, **DeepSeek Harness (`dsh`)** with the Haven Web3 plugin stack (15 plugins), **Prowlarr**, **qBittorrent**, **`yt-dlp`**, **`ffmpeg`**, and the **Observatory** status dashboard.

Designed for single-container runtimes with **no `docker compose` required** (`wslc`, plain `docker run`, or `podman run`). OpenMausBot is the sole communication surface and wallet owner (no XMTP/Convos, no Transmission).

> Looking for the smaller headless **Convos / XMTP** variant (with Transmission failover, no GUI)? See [`havencto/dsh-haven-web3-agent`](https://hub.docker.com/r/havencto/dsh-haven-web3-agent).

## Quickstart (single command)

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

docker logs -f haven-mausbot
```

On first boot the logs print:
1. Your generated **hot testnet wallet addresses** (EVM address + ICP principal — keys stay in `/data/keys` with mode `0600` and are never printed).
2. A one-time **OpenMausBot sign-in link & QR** (`http://localhost:8799/pair#code=...`). Open it in your browser (or paste it into the OpenMausBot desktop/mobile app).

Mint a fresh pairing code any time:

```sh
docker exec haven-mausbot openmausbot pair
```

## Model options

- **Any OpenAI-compatible endpoint (default `spark` provider)**: pass `MODEL_BASE_URL`, `MODEL_ID`, and `MODEL_API_KEY` (optional `MODEL_API_PROTOCOL`: `openai-completions`, `openai-responses`, or `anthropic-messages`).
- **DeepSeek API directly**: omit `MODEL_BASE_URL` and pass `-e DEEPSEEK_API_KEY=sk-...`.
- **Configure in GUI**: omit model env vars, boot with `-e ACCEPT_HOT_WALLET_RISK=yes`, and add providers under **Settings → AI → Providers**.

## Ports & surfaces

| Port | Service | Publish? |
|---|---|---|
| `8799` | OpenMausBot Web GUI & API (private/loopback networks via `OMB_LAN=1`) | Yes (`-p 8799:8799`) |
| `8787` | Observatory read-only status & spend dashboard | Optional (`-p 8787:8787`) |
| `9696` | Prowlarr indexer bridge (`127.0.0.1` only) | **Do not `-p`** |
| `8080` | qBittorrent WebUI (`127.0.0.1` only) | **Do not `-p`** |

For LAN or Tailscale pairing from another device, set `-e OMB_PUBLIC_URL=http://<your-lan-or-tailscale-ip>:8799`.

## What's inside

- **OpenMausBot** (`ghcr.io/milind-soni/openmausbot`) with **Haven Web3 (`dsh`)** pre-configured as the default engine (approval cards, multi-bot rooms, mobile/desktop pairing, built-in Chromium browser).
- **DeepSeek Harness (`@deepseek-ai/dsh`)** `acp` profile preloaded with 15 web3 plugins: `dsh-wallet`, `dsh-wallet-ethereum`, `dsh-wallet-tools`, `dsh-treasury`, `dsh-storage-synapse`, `dsh-arkiv`, `dsh-erc8004`, `dsh-royalty-router`, `dsh-haven-aol`, `dsh-persona`, `dsh-tool-prowlarr`, `dsh-tool-acquisition`, `dsh-observatory`, `dsh-exactly-once`, `dsh-agent-herald`.
- **Media pipeline**: Prowlarr (pre-seeded public indexers), `qbittorrent-nox`, `yt-dlp`, `ffmpeg`, `python3-mutagen`.

## Security & testnet posture

- **Hot wallets**: keys live in `/data/keys` (`0600`) and are managed by the agent. Refuses to instantiate without `ACCEPT_HOT_WALLET_RISK=yes`. Bring your own key with `-e AGENT_EVM_KEY=0x...` (64 hex chars).
- **Testnet defaults**: Sepolia, Base Sepolia, Filecoin Calibration, Arkiv Rabdi. Deposit only testnet funds or amounts you can afford to lose.
- **Persistent state**: everything lives in the `/data` volume (wallets, `dsh` profile/sessions, OpenMausBot chats/settings, Prowlarr indexers, downloads, logs). Existing `havencto/dsh-haven-web3-agent:latest` volumes upgrade in place.

Source & full documentation: [Haven-hvn/deepseek-harness-web3-agent-stack](https://github.com/Haven-hvn/deepseek-harness-web3-agent-stack).
