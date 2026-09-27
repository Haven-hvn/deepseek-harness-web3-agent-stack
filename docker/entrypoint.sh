#!/bin/sh
# Entrypoint: first-boot instantiation (keys, testnet profile, preseeds),
# then supervisor as PID 1. Secrets are generated into /data (0600) and
# NEVER printed — only addresses/principals reach the logs.
set -eu

DATA=/data
export DSH_HOME=/data/dsh

log() { echo "entrypoint: $*"; }

mkdir -p /data/logs /data/keys /data/downloads/acquire /data/xmtp /data/home

if [ ! -f "$DATA/.instantiated" ]; then
  if [ "${ACCEPT_HOT_WALLET_RISK:-}" != "yes" ]; then
    cat >&2 <<'EOF'
Refusing to instantiate: this container generates HOT wallets whose keys live
inside /data and are managed by the agent, not you.

  - Keys are NOT exportable by design; anyone with the volume (or container
    access) can spend everything.
  - Deposit ONLY what you are comfortable losing.
  - All chain defaults are TESTNETS (Sepolia, Base Sepolia, Filecoin
    calibration, Arkiv Tiramisu). Mainnet requires explicit reconfiguration.

Re-run with -e ACCEPT_HOT_WALLET_RISK=yes to accept and instantiate.
EOF
    exit 3
  fi

  for v in MODEL_BASE_URL MODEL_ID MODEL_API_KEY; do
    eval "val=\${$v:-}"
    if [ -z "$val" ]; then
      echo "entrypoint: $v is required (the user provides baseURL + model id + key)" >&2
      exit 3
    fi
  done

  log "generating hot wallets (EVM + ICP)..."
  SUMMARY_JSON=$(node /opt/agent/keys.mjs /data/keys)

  EVM_KEY=$(cat /data/keys/evm.key)
  XMTP_DB_KEY=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')
  PROWLARR_KEY=$(node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')
  printf '%s' "$PROWLARR_KEY" > /data/keys/prowlarr.key
  chmod 600 /data/keys/prowlarr.key

  umask 077
  mkdir -p /data/dsh
  cat > /data/dsh/.credentials.yaml <<EOF
AGENT_EVM_KEY: "$EVM_KEY"
XMTP_DB_KEY: "$XMTP_DB_KEY"
EOF
  chmod 600 /data/dsh/.credentials.yaml
  unset EVM_KEY XMTP_DB_KEY

  log "installing profile skeleton..."
  rm -rf /data/dsh/profiles
  cp -a /opt/dsh-skel/profiles /data/dsh/profiles
  cp /opt/agent/profile.patch.yml /data/dsh/profiles/agent/cordis.patch.yml
  # pnpm link: symlinks are relative to the skeleton — repoint the dangling
  # top-level links at the absolute /opt/stack sources. (No pnpm at runtime:
  # the profile volume is a different filesystem from the image store, which
  # pnpm refuses. The image is immutable, so links never need re-resolution.)
  log "re-linking stack packages into the profile..."
  for link in /data/dsh/profiles/agent/node_modules/dsh-*; do
    if [ -L "$link" ] && [ ! -e "$link" ]; then
      base=$(basename "$link")
      if [ -d "/opt/stack/$base" ]; then
        ln -sfn "/opt/stack/$base" "$link"
      else
        echo "entrypoint: cannot re-link $base (missing from /opt/stack)" >&2
        exit 3
      fi
    fi
  done

  log "preseeding service configs..."
  mkdir -p /data/prowlarr /data/transmission /data/home/.config/qBittorrent
  cat > /data/prowlarr/config.xml <<EOF
<Config>
  <BindAddress>*</BindAddress>
  <Port>9696</Port>
  <SslPort>6969</SslPort>
  <EnableSsl>False</EnableSsl>
  <LaunchBrowser>False</LaunchBrowser>
  <ApiKey>$PROWLARR_KEY</ApiKey>
  <AuthenticationMethod>None</AuthenticationMethod>
  <AuthenticationRequired>Enabled</AuthenticationRequired>
  <UrlBase></UrlBase>
  <InstanceName>Prowlarr</InstanceName>
  <LogLevel>info</LogLevel>
</Config>
EOF
  chmod 600 /data/prowlarr/config.xml
  cat > /data/home/.config/qBittorrent/qBittorrent.conf <<'EOF'
[LegalNotice]
Accepted=true

[Preferences]
WebUI\Enabled=true
WebUI\Port=8080
WebUI\LocalHostAuth=true
Downloads\SavePath=/data/downloads/torrents
EOF
  unset PROWLARR_KEY

  log "validating composed profile..."
  export PROWLARR_API_KEY
  PROWLARR_API_KEY=$(cat /data/keys/prowlarr.key)
  if ! dsh --profile agent --dump-config > /dev/null 2>/data/logs/dump-config.err.log; then
    echo "entrypoint: profile composition invalid; see /data/logs/dump-config.err.log" >&2
    exit 3
  fi

  touch "$DATA/.instantiated"

  EVM_ADDR=$(cat /data/keys/evm.address)
  ICP_PRINCIPAL=$(cat /data/keys/icp.principal)
  INBOX=$(cat /data/keys/inbox.id)
  cat <<EOF

================================================================
Agent instantiated. HOT wallets live in /data/keys (container-only).
  EVM address:    $EVM_ADDR
  ICP principal:  $ICP_PRINCIPAL
  XMTP inbox:     $INBOX

Fund with TESTNET assets only (faucets, never mainnet):
  Sepolia / Base Sepolia ETH, calibration tFIL.

A Convos invite QR prints to these logs once the agent is up —
scan it with the Convos app to chat. Re-print any time with:
  podman exec <container> /opt/agent/convos-qr.sh
================================================================
EOF
fi

export PROWLARR_API_KEY
PROWLARR_API_KEY=$(cat /data/keys/prowlarr.key)
log "starting supervisor tree..."
exec /usr/bin/supervisord -c /opt/agent/supervisord.conf
