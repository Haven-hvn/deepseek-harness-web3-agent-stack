#!/bin/sh
# Entrypoint for the all-in-one Haven Web3 + OpenMausBot GUI container.
#
# Runs under `/usr/bin/tini -s --` as PID 1 (collecting Chromium/agent orphans),
# instantiates hot keys (EVM + ICP) + the web3 `acp` dsh profile + preseeded
# Prowlarr/qBittorrent/OpenMausBot configs on first boot, reconciles image
# upgrades on subsequent boots, hands `/data` ownership to `maus`, and execs
# `supervisord`. Secrets are generated into `/data` (0600) and NEVER printed.
set -eu

DATA=/data
export DSH_HOME=/data/dsh
export OMB_DATA_DIR="${OMB_DATA_DIR:-/data/openmausbot}"
export OMB_PORT="${OMB_PORT:-8799}"
export OMB_WEBHOOK_PORT="${OMB_WEBHOOK_PORT:-8800}"
export OMB_LAN="${OMB_LAN:-1}"
export OMB_PUBLIC_URL="${OMB_PUBLIC_URL:-http://localhost:${OMB_PORT}}"
export OMB_SERVER_NAME="${OMB_SERVER_NAME:-Haven Web3 Agent}"
export OMB_CLI_PREFIX="${OMB_CLI_PREFIX:-openmausbot}"

log() { echo "entrypoint: $*"; }
sha256_of() { sha256sum "$1" | cut -d' ' -f1; }

SKEL_ID_SRC=/opt/dsh-skel/.skel-id
SKEL_ID_STAMP=/data/.profile-acp-skel-id
PROFILE_DIR=/data/dsh/profiles/acp
PATCH_SRC=/opt/agent/profile.acp.patch.yml
PATCH_DST=/data/dsh/profiles/acp/cordis.patch.yml
PATCH_STAMP=/data/.profile-acp-patch.sha256

# Repoint dangling relative pnpm `link:` symlinks in the profile to `/opt/stack`.
relink_stack() {
  for link in "$1"/node_modules/dsh-*; do
    if [ -L "$link" ] && [ ! -e "$link" ]; then
      base=$(basename "$link")
      if [ -d "/opt/stack/$base" ]; then
        ln -sfn "/opt/stack/$base" "$link"
      else
        echo "entrypoint: cannot re-link $base (missing from /opt/stack)" >&2
        return 1
      fi
    fi
  done
}

# Reconcile the `acp` profile user patch layer (`cordis.patch.yml`) against the
# image's shipped patch according to PROFILE_PATCH_POLICY (auto|keep|replace).
refresh_profile_patch() {
  [ -d "$PROFILE_DIR" ] || return 0
  if [ ! -f "$PATCH_DST" ]; then
    cp "$PATCH_SRC" "$PATCH_DST"
    sha256_of "$PATCH_SRC" > "$PATCH_STAMP"
    return 0
  fi
  policy="${PROFILE_PATCH_POLICY:-auto}"
  new=$(sha256_of "$PATCH_SRC")
  cur=$(sha256_of "$PATCH_DST")
  [ "$new" = "$cur" ] && { printf '%s\n' "$new" > "$PATCH_STAMP"; return 0; }
  stamp=$(cat "$PATCH_STAMP" 2>/dev/null || true)
  case "$policy" in
    keep)
      log "acp profile layer differs from image; PROFILE_PATCH_POLICY=keep, leaving it"
      return 0 ;;
    replace) ;;
    auto)
      if [ -n "$stamp" ] && [ "$cur" != "$stamp" ]; then
        log "WARNING: acp profile layer was edited since install; NOT refreshing it."
        log "  merge $PATCH_SRC by hand, or re-run with PROFILE_PATCH_POLICY=replace"
        return 0
      fi ;;
    *)
      echo "entrypoint: unknown PROFILE_PATCH_POLICY=$policy (auto|keep|replace)" >&2
      exit 3 ;;
  esac
  backup="$PATCH_DST.bak-$(date +%Y%m%d%H%M%S)"
  cp "$PATCH_DST" "$backup"
  cp "$PATCH_SRC" "$PATCH_DST"
  if dsh --profile acp --dump-config > /dev/null 2>/data/logs/dump-config-acp.err.log; then
    printf '%s\n' "$new" > "$PATCH_STAMP"
    log "acp profile layer refreshed to image's (previous: $backup)"
  else
    cp "$backup" "$PATCH_DST"
    log "WARNING: refreshed acp layer failed validation (see /data/logs/dump-config-acp.err.log); restored $backup"
  fi
}

# Ensure the `acp` profile exists (handles upgrading an existing `:latest` volume).
ensure_acp_profile() {
  [ -d "$PROFILE_DIR" ] && return 0
  log "installing acp profile from image skeleton..."
  mkdir -p /data/dsh/profiles
  cp -a /opt/dsh-skel/profiles/acp "$PROFILE_DIR"
  cp "$PATCH_SRC" "$PATCH_DST"
  sha256_of "$PATCH_SRC" > "$PATCH_STAMP"
  relink_stack "$PROFILE_DIR" || exit 3
  cp "$SKEL_ID_SRC" "$SKEL_ID_STAMP"
}

# Replace the `acp` profile install artifacts when `.skel-id` moved.
refresh_profile_install() {
  [ -d "$PROFILE_DIR" ] || return 0
  [ -f "$SKEL_ID_SRC" ] || { log "image has no skeleton id; skipping profile install refresh"; return 0; }
  new=$(cat "$SKEL_ID_SRC")
  cur=$(cat "$SKEL_ID_STAMP" 2>/dev/null || true)
  [ "$new" = "$cur" ] && return 0
  case "${PROFILE_INSTALL_POLICY:-auto}" in
    keep)
      log "WARNING: acp profile install predates this image; PROFILE_INSTALL_POLICY=keep, leaving it"
      return 0 ;;
    auto) ;;
    *)
      echo "entrypoint: unknown PROFILE_INSTALL_POLICY=${PROFILE_INSTALL_POLICY} (auto|keep)" >&2
      exit 3 ;;
  esac
  log "image profile skeleton changed (${cur:-unstamped} -> $new); refreshing acp profile install..."
  staged=/data/dsh/profiles/.acp.new
  backup="/data/dsh/profiles/.acp.bak-$(date +%Y%m%d%H%M%S)"
  rm -rf "$staged"
  cp -a /opt/dsh-skel/profiles/acp "$staged"
  for keep in cordis.patch.yml compatibility.json; do
    [ ! -f "$PROFILE_DIR/$keep" ] || cp -p "$PROFILE_DIR/$keep" "$staged/$keep"
  done
  relink_stack "$staged" || { rm -rf "$staged"; exit 3; }
  node -e '
    const read = p => Object.keys(JSON.parse(require("fs").readFileSync(p, "utf8")).dependencies ?? {})
    const dropped = read(process.argv[1]).filter(d => !read(process.argv[2]).includes(d))
    if (dropped.length) console.log("entrypoint: WARNING (acp): not in image skeleton, dropped: " + dropped.join(", "))
  ' "$PROFILE_DIR/package.json" "$staged/package.json" || true
  rm -rf /data/dsh/profiles/.acp.bak-*
  mv "$PROFILE_DIR" "$backup"
  mv "$staged" "$PROFILE_DIR"
  INSTALL_BACKUP=$backup
}

validate_refresh() {
  [ -n "${INSTALL_BACKUP:-}" ] || return 0
  if dsh --profile acp --dump-config > /dev/null 2>/data/logs/dump-config-acp.err.log; then
    cp "$SKEL_ID_SRC" "$SKEL_ID_STAMP"
    log "acp profile install refreshed (previous install kept at $INSTALL_BACKUP)"
  else
    rm -rf "$PROFILE_DIR"
    mv "$INSTALL_BACKUP" "$PROFILE_DIR"
    echo "entrypoint: refreshed acp profile failed validation (see /data/logs/dump-config-acp.err.log); restored previous install." >&2
    exit 3
  fi
}

# Ensure `.credentials.yaml` carries DEEPSEEK_API_KEY when either a real
# DeepSeek key or a custom `spark` MODEL_BASE_URL is configured so OpenMausBot's
# built-in `deepseekAgent` driver marks the Haven Web3 engine authenticated.
sync_dsh_credentials_deepseek() {
  creds=/data/dsh/.credentials.yaml
  [ -f "$creds" ] || return 0
  node -e '
    const fs = require("fs");
    const path = process.argv[1];
    const realKey = (process.env.DEEPSEEK_API_KEY || "").trim();
    const hasSpark = Boolean((process.env.MODEL_BASE_URL || "").trim());
    let text = fs.readFileSync(path, "utf8");
    const hasLine = /^[ \t]*DEEPSEEK_API_KEY[ \t]*:/m.test(text);
    if (realKey) {
      const line = `DEEPSEEK_API_KEY: ${JSON.stringify(realKey)}`;
      text = hasLine ? text.replace(/^[ \t]*DEEPSEEK_API_KEY[ \t]*:.*$/m, line) : `${text.trimEnd()}\n${line}\n`;
      fs.writeFileSync(path, text, { mode: 0o600 });
    } else if (hasSpark && !hasLine) {
      text = `${text.trimEnd()}\nDEEPSEEK_API_KEY: "spark-provider-active"\n`;
      fs.writeFileSync(path, text, { mode: 0o600 });
    }
  ' "$creds"
  chmod 600 "$creds"
}

mkdir -p /data/logs /data/keys /data/downloads/acquire /data/downloads/torrents \
  /data/home /data/observatory /data/prowlarr /data/home/.config/qBittorrent \
  "$OMB_DATA_DIR" /data/openmausbot-home

if [ -n "${MODEL_BASE_URL:-}" ] && { [ -z "${MODEL_ID:-}" ] || [ -z "${MODEL_API_KEY:-}" ]; }; then
  echo "entrypoint: MODEL_BASE_URL is set, so MODEL_ID and MODEL_API_KEY are also required" >&2
  exit 3
fi

if [ ! -f "$DATA/.instantiated" ]; then
  if [ "${ACCEPT_HOT_WALLET_RISK:-}" != "yes" ]; then
    cat >&2 <<'EOF'
Refusing to instantiate: this container generates HOT wallets whose keys live
inside /data and are managed by the agent, not you.

  - Keys are NOT exportable by design; anyone with the volume (or container
    access) can spend everything.
  - Deposit ONLY what you are comfortable losing.
  - All chain defaults are TESTNETS (Sepolia, Base Sepolia, Filecoin
    calibration, Arkiv Rabdi). Mainnet requires explicit reconfiguration.

Re-run with -e ACCEPT_HOT_WALLET_RISK=yes to accept and instantiate.
EOF
    exit 3
  fi

  log "generating hot wallets (EVM + ICP)..."
  SUMMARY_JSON=$(node /opt/agent/keys.mjs --no-xmtp /data/keys)

  EVM_KEY=$(cat /data/keys/evm.key)
  PROWLARR_KEY=$(node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')
  printf '%s' "$PROWLARR_KEY" > /data/keys/prowlarr.key
  chmod 600 /data/keys/prowlarr.key

  umask 077
  mkdir -p /data/dsh
  cat > /data/dsh/.credentials.yaml <<EOF
AGENT_EVM_KEY: "$EVM_KEY"
EOF
  chmod 600 /data/dsh/.credentials.yaml
  unset EVM_KEY
  sync_dsh_credentials_deepseek

  log "installing dsh acp profile skeleton..."
  rm -rf "$PROFILE_DIR"
  mkdir -p /data/dsh/profiles
  cp -a /opt/dsh-skel/profiles/acp "$PROFILE_DIR"
  cp "$PATCH_SRC" "$PATCH_DST"
  sha256_of "$PATCH_SRC" > "$PATCH_STAMP"
  log "re-linking stack packages into acp profile..."
  relink_stack "$PROFILE_DIR" || exit 3
  cp "$SKEL_ID_SRC" "$SKEL_ID_STAMP"

  log "preseeding Prowlarr and qBittorrent configs..."
  cat > /data/prowlarr/config.xml <<EOF
<Config>
  <BindAddress>127.0.0.1</BindAddress>
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
WebUI\LocalHostAuth=false
WebUI\AuthSubnetWhitelistEnabled=true
WebUI\AuthSubnetWhitelist=127.0.0.1/32
Downloads\SavePath=/data/downloads/torrents
EOF
  unset PROWLARR_KEY

  log "validating composed acp profile..."
  export PROWLARR_API_KEY
  PROWLARR_API_KEY=$(cat /data/keys/prowlarr.key)
  if ! dsh --profile acp --dump-config > /dev/null 2>/data/logs/dump-config-acp.err.log; then
    echo "entrypoint: acp profile composition invalid; see /data/logs/dump-config-acp.err.log" >&2
    exit 3
  fi

  touch "$DATA/.instantiated"

  EVM_ADDR=$(cat /data/keys/evm.address)
  ICP_PRINCIPAL=$(cat /data/keys/icp.principal)
  cat <<EOF

================================================================
Haven Web3 + OpenMausBot instantiated. HOT wallets live in /data/keys.
  EVM address:    $EVM_ADDR
  ICP principal:  $ICP_PRINCIPAL

Fund with TESTNET assets only (faucets, never mainnet):
  Sepolia / Base Sepolia ETH, calibration tFIL.

Surfaces:
  OpenMausBot GUI:  $OMB_PUBLIC_URL  (pairing link prints below once up)
  Observatory:      http://localhost:8787
  Mint new GUI pair code:  docker exec <container> openmausbot pair
================================================================
EOF
fi

export PROWLARR_API_KEY
PROWLARR_API_KEY=$(cat /data/keys/prowlarr.key)

# Persist current model env vars for `dsh-acp-wrapper.sh` (0600, updated on boot
# when provided) and keep `.credentials.yaml` aligned for OpenMausBot's
# `deepseekAgent` authentication check.
node /opt/agent/seed-openmausbot.mjs --write-model-env /data/keys/model.env
sync_dsh_credentials_deepseek

# Support seamless upgrades from headless `:latest` volumes (which lack `acp`
# and `/data/openmausbot/config.json`) as well as `:mausbot` image upgrades.
ensure_acp_profile
refresh_profile_install
refresh_profile_patch
validate_refresh

# Seed OpenMausBot config on first GUI boot (idempotent; preserves user edits).
node /opt/agent/seed-openmausbot.mjs "$OMB_DATA_DIR" > /dev/null

# Hand runtime state ownership to `maus` without recursively scanning large
# completed downloads on every restart.
chown maus:maus /data /data/downloads /data/downloads/acquire /data/downloads/torrents
chown -R maus:maus /data/logs /data/keys /data/dsh /data/home \
  /data/observatory /data/prowlarr "$OMB_DATA_DIR" /data/openmausbot-home

log "starting supervisor tree..."
exec /usr/bin/supervisord -c /opt/agent/supervisord.conf
