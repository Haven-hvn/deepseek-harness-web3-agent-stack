# Single fat agent image: dsh CLI + web3 agent stack + media/torrent binaries.
# All state lives in /data (keys, profile, service data). First boot runs
# instantiation (keys, testnet profile, indexers); every boot starts the
# supervisor tree. See README.md for run instructions.
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DSH_TELEMETRY_DISABLED=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# OS binaries: torrent clients, media, QR, supervision. libicu72 for the
# self-contained Prowlarr build on slim.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils \
      libicu72 \
      qbittorrent-nox transmission-daemon \
      ffmpeg qrencode supervisor \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp standalone binary (pinned).
ARG YTDLP_VERSION=2026.08.19
RUN curl -fsSL -o /usr/local/bin/yt-dlp \
      "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_linux" \
    && chmod +x /usr/local/bin/yt-dlp \
    && yt-dlp --version

# Prowlarr self-contained build (pinned, no dotnet needed).
ARG PROWLARR_VERSION=2.6.5.5623
RUN curl -fsSL -o /tmp/prowlarr.tar.gz \
      "https://github.com/Prowlarr/Prowlarr/releases/download/v${PROWLARR_VERSION}/Prowlarr.master.${PROWLARR_VERSION}.linux-core-x64.tar.gz" \
    && mkdir -p /opt/prowlarr && tar -xzf /tmp/prowlarr.tar.gz -C /opt/prowlarr \
    && rm /tmp/prowlarr.tar.gz

# Published CLIs (pinned) + pnpm for profile assembly.
RUN npm i -g @deepseek-ai/dsh@0.1.7-rc.2 @xmtp/convos-cli@0.10.23 pnpm@11.7.0 \
    && npm cache clean --force

# Agent helper runtime: keys.mjs resolves these from sibling node_modules
# (ESM does not see global installs).
COPY docker/agent.package.json /opt/agent/package.json
RUN cd /opt/agent && npm i --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# Agent scripts + profile user layer + supervisor tree.
COPY docker/keys.mjs docker/entrypoint.sh docker/convos-qr.sh \
     docker/setup-indexers.mjs docker/profile.patch.yml \
     docker/supervisord.conf /opt/agent/
RUN chmod +x /opt/agent/entrypoint.sh /opt/agent/convos-qr.sh

# Web3 agent stack source (node_modules/lib excluded via .dockerignore).
# One COPY per package: multi-source COPY merges directory contents.
COPY dsh-wallet/ /opt/stack/dsh-wallet/
COPY dsh-wallet-ethereum/ /opt/stack/dsh-wallet-ethereum/
COPY dsh-wallet-tools/ /opt/stack/dsh-wallet-tools/
COPY dsh-treasury/ /opt/stack/dsh-treasury/
COPY dsh-channel-xmtp/ /opt/stack/dsh-channel-xmtp/
COPY dsh-storage-synapse/ /opt/stack/dsh-storage-synapse/
COPY dsh-arkiv/ /opt/stack/dsh-arkiv/
COPY dsh-erc8004/ /opt/stack/dsh-erc8004/
COPY dsh-royalty-router/ /opt/stack/dsh-royalty-router/
COPY dsh-haven-aol/ /opt/stack/dsh-haven-aol/
COPY dsh-persona/ /opt/stack/dsh-persona/
COPY dsh-tool-prowlarr/ /opt/stack/dsh-tool-prowlarr/
COPY dsh-tool-acquisition/ /opt/stack/dsh-tool-acquisition/

# Profile skeleton: base bundles + all stack packages + xmtp runtime dep.
# Built once here; first boot copies it into /data (never rebuilt at runtime).
ENV DSH_HOME=/opt/dsh-skel
RUN dsh plugin --profile agent add \
      /opt/stack/dsh-wallet /opt/stack/dsh-wallet-ethereum \
      /opt/stack/dsh-wallet-tools /opt/stack/dsh-treasury \
      /opt/stack/dsh-channel-xmtp /opt/stack/dsh-storage-synapse \
      /opt/stack/dsh-arkiv /opt/stack/dsh-erc8004 \
      /opt/stack/dsh-royalty-router /opt/stack/dsh-haven-aol \
      /opt/stack/dsh-persona /opt/stack/dsh-tool-prowlarr \
      /opt/stack/dsh-tool-acquisition \
    && dsh plugin --profile agent add @xmtp/node-sdk \
    && dsh --profile agent --dump-default-config > /dev/null

VOLUME /data
ENTRYPOINT ["/opt/agent/entrypoint.sh"]

LABEL org.opencontainers.image.title="dsh web3 agent (all-in-one)" \
      org.opencontainers.image.description="DeepSeek Harness + web3 agent stack + Prowlarr/torrent/media binaries. Hot internal wallets, testnet defaults."
