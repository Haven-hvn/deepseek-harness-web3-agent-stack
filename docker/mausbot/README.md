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

- **Any OpenAI-compatible endpoint (`spark` provider)**: pass `MODEL_BASE_URL` and `MODEL_ID`. `MODEL_API_KEY` is optional — local servers such as LM Studio need no key and get a harmless placeholder. `MODEL_API_PROTOCOL` defaults to `openai-completions` (`openai-responses` / `anthropic-messages` also accepted).
- **DeepSeek API directly**: omit `MODEL_BASE_URL` and pass `-e DEEPSEEK_API_KEY=sk-...`.
- **Configure in GUI**: omit model env vars, boot with `-e ACCEPT_HOT_WALLET_RISK=yes`, and add providers under **Settings → AI → Providers**.

| Env | Meaning | Default |
|---|---|---|
| `MODEL_BASE_URL` | OpenAI-compatible base URL (enables `spark`) | unset → native DeepSeek |
| `MODEL_ID` | Model id served by that endpoint | required with `MODEL_BASE_URL` |
| `MODEL_API_KEY` | Bearer key; optional for local endpoints | `local-endpoint-no-key` |
| `MODEL_API_PROTOCOL` | pi-ai API family | `openai-completions` |
| `MODEL_CONTEXT_WINDOW` | Context window DSH should assume | `131072` |
| `MODEL_MAX_OUTPUT_TOKENS` | Max completion tokens | `32768` |
| `MODEL_REASONING_EFFORT` | `none` / `low` / `medium`; enables reasoning verbs | unset (no reasoning options) |

`MODEL_REASONING_EFFORT` maps to Upstage's verbs (`off→none`, `low→low`, `medium→medium`); other endpoints may use different strings, so leave it unset unless you know yours accepts `reasoning_effort`.

### Local endpoints (LM Studio etc.) — read this first

`127.0.0.1` **inside** the container is the container itself, not your host. Use the host's address as seen from the container, and bind LM Studio to `0.0.0.0:1234`:

- **wslc** (verified): `-e MODEL_BASE_URL=http://host.wslc.internal:1234/v1`
- **Docker on Linux**: add `--add-host host.docker.internal:host-gateway`, then `-e MODEL_BASE_URL=http://host.docker.internal:1234/v1`
- **podman / Linux**: run with `--network host`, then `-e MODEL_BASE_URL=http://127.0.0.1:1234/v1`

Example (wslc):

```sh
wslc run -d --name haven-mausbot \
  -p 8799:8799 -p 8787:8787 -v haven-data:/data \
  -e ACCEPT_HOT_WALLET_RISK=yes \
  -e MODEL_BASE_URL=http://host.wslc.internal:1234/v1 \
  -e MODEL_ID=bonsai27b \
  havencto/dsh-haven-mausbot:latest
```

Local-model turns are protected: pi-ai sends neither `store` nor the `developer` role, uses `max_tokens`, has one-hour idle/total provider timeouts, and the agent process preloads a one-hour undici body-timeout override. MausBot's turn timers are seeded to 60 minutes (`OMB_TURN_STALL_MS`, `OPENMAUS_ACP_PROMPT_IDLE_TIMEOUT_MS`, `rooms.turnTimeoutMinutes`); `OMB_TOOL_STALL_MS` keeps its two-hour default. Set `MODEL_CONTEXT_WINDOW=65536` for a 64K local model instead of the 128K default.

Environment lives in the container config, not the `/data` volume — re-pass the same `-e` flags when recreating after an image upgrade (the model settings are persisted in `/data/keys/model.env` for the agent, but the container still needs its env on recreate).

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
