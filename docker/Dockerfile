# Single fat agent image: dsh CLI + web3 agent stack + media/torrent binaries.
# All state lives in /data (keys, profile, service data). First boot runs
# instantiation (keys, testnet profile, indexers); every boot starts the
# supervisor tree. See README.md for run instructions.
FROM node:22.23-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DSH_TELEMETRY_DISABLED=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true

# OS binaries: torrent clients, media, QR, supervision. libicu72 for the
# self-contained Prowlarr build on slim. python3-mutagen writes the ID3
# CHAP/CTOC chapters ffmpeg cannot emit into MP3 (process.md §1 step 2).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git xz-utils \
      libicu72 \
      qbittorrent-nox transmission-daemon \
      ffmpeg qrencode supervisor \
      python3 python3-pip python3-mutagen \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp (pinned, pure Python — works on ARM64 and x64).
ARG YTDLP_VERSION=2026.08.19
RUN pip3 install --no-cache-dir --break-system-packages "yt-dlp==${YTDLP_VERSION}" \
    && yt-dlp --version

# Prowlarr self-contained build (pinned, no dotnet needed).
# TARGETARCH is set automatically by BuildKit (amd64/arm64).
# Prowlarr uses x64 instead of amd64 in their release URLs.
ARG PROWLARR_VERSION=2.6.5.5623
ARG TARGETARCH
RUN case "${TARGETARCH}" in \
      amd64) PROWLARR_ARCH=x64 ;; \
      arm64) PROWLARR_ARCH=arm64 ;; \
      *) echo "Unsupported architecture: ${TARGETARCH}" && exit 1 ;; \
    esac \
    && curl -fsSL -o /tmp/prowlarr.tar.gz \
      "https://github.com/Prowlarr/Prowlarr/releases/download/v${PROWLARR_VERSION}/Prowlarr.master.${PROWLARR_VERSION}.linux-core-${PROWLARR_ARCH}.tar.gz" \
    && mkdir -p /opt/prowlarr && tar -xzf /tmp/prowlarr.tar.gz -C /opt/prowlarr \
    && rm /tmp/prowlarr.tar.gz

# Published CLIs (pinned) + pnpm for profile assembly. dsh gates every
# plugin's @deepseek-ai/dsh-* peers against this runtime version at
# `dsh plugin add` and profile boot, so this pin must equal the stack's peers.
RUN npm i -g @deepseek-ai/dsh@0.2.1-alpha.1 @xmtp/convos-cli@0.10.23 pnpm@11.7.0 \
    && npm cache clean --force

# Agent helper runtime: keys.mjs resolves these from sibling node_modules
# (ESM does not see global installs).
COPY docker/agent.package.json /opt/agent/package.json
RUN cd /opt/agent && npm i --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# Agent scripts + profile user layer + supervisor tree.
# Strip CR from shell scripts: a Windows checkout (core.autocrlf / OneDrive)
# rewrites them to CRLF, which makes the shebang `#!/bin/sh\r` unresolvable
# and the container fail with "exec /opt/agent/entrypoint.sh: no such file".
# Normalising here keeps the build correct regardless of host git settings.
COPY docker/keys.mjs docker/entrypoint.sh docker/convos-qr.sh \
     docker/setup-indexers.mjs docker/profile.patch.yml \
     docker/supervisord.conf /opt/agent/
RUN sed -i 's/\r$//' /opt/agent/entrypoint.sh /opt/agent/convos-qr.sh \
    && chmod +x /opt/agent/entrypoint.sh /opt/agent/convos-qr.sh \
    && sh -n /opt/agent/entrypoint.sh \
    && sh -n /opt/agent/convos-qr.sh

# Web3 agent stack workspace root (for in-image install + build).
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json .npmrc /opt/stack/
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
COPY dsh-observatory/ /opt/stack/dsh-observatory/
COPY dsh-exactly-once/ /opt/stack/dsh-exactly-once/
COPY dsh-agent-herald/ /opt/stack/dsh-agent-herald/

# haven-aol source: dsh-haven-aol depends on it via
# file:../../haven-aol/packages/typescript, which resolves to /opt/haven-aol
# from /opt/stack. Pinned to the commit the stack was developed against.
ARG HAVEN_AOL_REF=29327ae849f2fd10205828b089fedfbff5849837
RUN git init -q /opt/haven-aol && cd /opt/haven-aol \
    && git remote add origin https://github.com/Haven-hvn/haven-aol.git \
    && git fetch -q --depth 1 origin ${HAVEN_AOL_REF} && git checkout -q FETCH_HEAD \
    && rm -rf .git \
    && cd packages/typescript && npm ci --no-audit --no-fund --ignore-scripts \
    && npm run build && npm prune --omit=dev \
    && npm cache clean --force

# Royalty-router SDK: dsh-royalty-router depends on it via
# file:../../mint-glue-graduate/sdk, which resolves to /opt/mint-glue-graduate
# from /opt/stack. Pinned like haven-aol above.
ARG ROYALTY_REF=5f8b8b79f22e4d10508059c56874ee409d26b581
RUN git init -q /opt/mint-glue-graduate && cd /opt/mint-glue-graduate \
    && git remote add origin https://github.com/Haven-hvn/mint-glue-graduate.git \
    && git fetch -q --depth 1 origin ${ROYALTY_REF} && git checkout -q FETCH_HEAD \
    && rm -rf .git \
    && cd sdk && npm ci --no-audit --no-fund --ignore-scripts \
    && npm run build && npm prune --omit=dev \
    && npm cache clean --force

# Build the stack in-image (lib/ is dockerignored out of the context, so the
# profile links would otherwise point at unbuilt sources). Plugin imports
# resolve from /opt/stack, not from the global dsh install. Peers live in
# devDependencies, so do not `pnpm prune --prod` — that removes cordis and
# every bundle fails to import.
RUN cd /opt/stack && pnpm install --frozen-lockfile --ignore-scripts \
    && pnpm -r build

# Profile skeleton: base bundles + all stack packages + xmtp runtime dep.
# Built once here; first boot copies it into /data, and a later image whose
# skeleton id differs (new dsh CLI, stack lockfile, or profile manifest)
# replaces the volume's install artifacts on boot (entrypoint.sh,
# refresh_profile_install). Never rebuilt with pnpm at runtime.
# Do not `pnpm store prune` here. With no project in cwd it drops the store
# packages /opt/stack/node_modules still links.
ENV DSH_HOME=/opt/dsh-skel
# dsh-exactly-once installs first so its tools/execute wrapper registers
# outermost: redelivered calls replay before any other wrapper runs.
RUN dsh plugin --profile agent add \
      /opt/stack/dsh-exactly-once \
      /opt/stack/dsh-wallet /opt/stack/dsh-wallet-ethereum \
      /opt/stack/dsh-wallet-tools /opt/stack/dsh-treasury \
      /opt/stack/dsh-channel-xmtp /opt/stack/dsh-storage-synapse \
      /opt/stack/dsh-arkiv /opt/stack/dsh-erc8004 \
      /opt/stack/dsh-royalty-router /opt/stack/dsh-haven-aol \
      /opt/stack/dsh-persona /opt/stack/dsh-tool-prowlarr \
      /opt/stack/dsh-tool-acquisition /opt/stack/dsh-observatory \
      /opt/stack/dsh-agent-herald \
    && dsh plugin --profile agent add @xmtp/node-sdk \
    && dsh --profile agent --dump-default-config > /dev/null \
    && node --input-type=module -e "await import('/opt/stack/dsh-wallet/lib/index.js'); await import('/opt/stack/dsh-channel-xmtp/lib/index.js'); await import('/opt/stack/dsh-tool-acquisition/lib/index.js'); await import('/opt/stack/dsh-observatory/lib/index.js'); await import('/opt/stack/dsh-exactly-once/lib/index.js'); await import('/opt/stack/dsh-agent-herald/lib/index.js'); console.log('stack import gate: OK')" \
    && { dsh --version; \
         sha256sum /opt/dsh-skel/profiles/agent/package.json /opt/stack/pnpm-lock.yaml; \
         [ ! -f /opt/dsh-skel/profiles/agent/pnpm-lock.yaml ] || sha256sum /opt/dsh-skel/profiles/agent/pnpm-lock.yaml; \
       } | sha256sum | cut -d' ' -f1 > /opt/dsh-skel/.skel-id \
    && echo "profile skeleton id: $(cat /opt/dsh-skel/.skel-id)"

EXPOSE 8787
VOLUME /data
ENTRYPOINT ["/opt/agent/entrypoint.sh"]

LABEL org.opencontainers.image.title="dsh web3 agent (all-in-one)" \
      org.opencontainers.image.description="DeepSeek Harness + web3 agent stack + Prowlarr/torrent/media binaries. Hot internal wallets, testnet defaults."
