#!/bin/sh
# Entrypoint: first-boot instantiation (keys, testnet profile, preseeds),
# then supervisor as PID 1. Secrets are generated into /data (0600) and
# NEVER printed — only addresses/principals reach the logs.
set -eu

DATA=/data
export DSH_HOME=/data/dsh

log() { echo "entrypoint: $*"; }

# The image's profile user layer, its installed copy, and the hash of the
# image layer last installed (detects operator/config-editor edits).
PATCH_SRC=/opt/agent/profile.patch.yml
PATCH_DST=/data/dsh/profiles/agent/cordis.patch.yml
PATCH_STAMP=/data/.profile-patch.sha256
sha256_of() { sha256sum "$1" | cut -d' ' -f1; }

# Bring an existing volume's profile user layer up to the image's. Policy
# (PROFILE_PATCH_POLICY): auto (default) replaces it when it is unmodified
# since the last install, or unstamped (pre-stamp volumes; the old copy is
# kept as a .bak); keep never touches it; replace always does (with .bak).
# A refreshed layer must pass --dump-config, otherwise the old one is restored.
refresh_profile_patch() {
  [ -f "$PATCH_DST" ] || return 0
  policy=${PROFILE_PATCH_POLICY:-auto}
  new=$(sha256_of "$PATCH_SRC")
  cur=$(sha256_of "$PATCH_DST")
  [ "$new" = "$cur" ] && { printf '%s\n' "$new" > "$PATCH_STAMP"; return 0; }
  stamp=$(cat "$PATCH_STAMP" 2>/dev/null || true)
  case "$policy" in
    keep)
      log "profile layer differs from the image's; PROFILE_PATCH_POLICY=keep, leaving it"
      return 0 ;;
    replace) ;;
    auto)
      if [ -n "$stamp" ] && [ "$cur" != "$stamp" ]; then
        log "WARNING: profile layer was edited since install; NOT refreshing it to the image's."
        log "  merge /opt/agent/profile.patch.yml by hand, or re-run with PROFILE_PATCH_POLICY=replace"
        return 0
      fi ;;
    *)
      echo "entrypoint: unknown PROFILE_PATCH_POLICY=$policy (auto|keep|replace)" >&2
      exit 3 ;;
  esac
  backup="$PATCH_DST.bak-$(date +%Y%m%d%H%M%S)"
  cp "$PATCH_DST" "$backup"
  cp "$PATCH_SRC" "$PATCH_DST"
  if dsh --profile agent --dump-config > /dev/null 2>/data/logs/dump-config.err.log; then
    printf '%s\n' "$new" > "$PATCH_STAMP"
    log "profile layer refreshed to the image's (previous: $backup)"
  else
    cp "$backup" "$PATCH_DST"
    log "WARNING: refreshed profile layer failed validation (see /data/logs/dump-config.err.log); restored $backup"
  fi
}

mkdir -p /data/logs /data/keys /data/downloads/acquire /data/xmtp /data/home

# Identity of the image's profile skeleton (dsh CLI version + stack lockfile +
# skeleton manifest), written by the Dockerfile, and the id last installed
# into this volume.
SKEL_ID_SRC=/opt/dsh-skel/.skel-id
SKEL_ID_STAMP=/data/.profile-skel-id
PROFILE_DIR=/data/dsh/profiles/agent

# pnpm link: symlinks are relative to the skeleton — repoint the dangling
# top-level links at the absolute /opt/stack sources. (No pnpm at runtime:
# the profile volume is a different filesystem from the image store, which
# pnpm refuses. The image is immutable, so links never need re-resolution.)
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

# Replace an existing volume's profile INSTALL artifacts (package.json,
# lockfile, node_modules) with this image's skeleton when the skeleton id
# changed, i.e. on an image upgrade (new dsh CLI / stack versions). Without
# this a volume keeps the first image's profile install forever. User-owned
# files are carried over: cordis.patch.yml (then reconciled by
# refresh_profile_patch) and compatibility.json. Sessions, credentials,
# storages, and keys live outside the profile dir and are untouched.
# Policy (PROFILE_INSTALL_POLICY): auto (default) | keep.
refresh_profile_install() {
  [ -d "$PROFILE_DIR" ] || return 0
  [ -f "$SKEL_ID_SRC" ] || { log "image has no skeleton id; skipping profile install refresh"; return 0; }
  new=$(cat "$SKEL_ID_SRC")
  cur=$(cat "$SKEL_ID_STAMP" 2>/dev/null || true)
  [ "$new" = "$cur" ] && return 0
  case "${PROFILE_INSTALL_POLICY:-auto}" in
    keep)
      log "WARNING: profile install predates this image; PROFILE_INSTALL_POLICY=keep, leaving it (dsh may deny stale bundles)"
      return 0 ;;
    auto) ;;
    *)
      echo "entrypoint: unknown PROFILE_INSTALL_POLICY=${PROFILE_INSTALL_POLICY} (auto|keep)" >&2
      exit 3 ;;
  esac
  log "image profile skeleton changed (${cur:-unstamped} -> $new); refreshing the profile install..."
  staged=/data/dsh/profiles/.agent.new
  backup=/data/dsh/profiles/.agent.bak-$(date +%Y%m%d%H%M%S)
  rm -rf "$staged"
  cp -a /opt/dsh-skel/profiles/agent "$staged"
  for keep in cordis.patch.yml compatibility.json; do
    [ ! -f "$PROFILE_DIR/$keep" ] || cp -p "$PROFILE_DIR/$keep" "$staged/$keep"
  done
  relink_stack "$staged" || { rm -rf "$staged"; exit 3; }
  # Plugins added into the volume by hand are not in the image skeleton.
  node -e '
    const read = p => Object.keys(JSON.parse(require("fs").readFileSync(p, "utf8")).dependencies ?? {})
    const dropped = read(process.argv[1]).filter(d => !read(process.argv[2]).includes(d))
    if (dropped.length) console.log("entrypoint: WARNING: not in the image skeleton, dropped from the profile: " + dropped.join(", ") + " (re-add them, or bake them into the image)")
  ' "$PROFILE_DIR/package.json" "$staged/package.json" || true
  rm -rf /data/dsh/profiles/.agent.bak-*
  mv "$PROFILE_DIR" "$backup"
  mv "$staged" "$PROFILE_DIR"
  # Validated after refresh_profile_patch has reconciled the user layer
  # (the old layer may itself need the image's update): see validate_refresh.
  INSTALL_BACKUP=$backup
}

# Final gate after an install refresh: the new install plus the reconciled
# user layer must compose; otherwise restore the previous install and stop.
validate_refresh() {
  [ -n "${INSTALL_BACKUP:-}" ] || return 0
  if dsh --profile agent --dump-config > /dev/null 2>/data/logs/dump-config.err.log; then
    cp "$SKEL_ID_SRC" "$SKEL_ID_STAMP"
    log "profile install refreshed (previous install kept at $INSTALL_BACKUP)"
  else
    rm -rf "$PROFILE_DIR"
    mv "$INSTALL_BACKUP" "$PROFILE_DIR"
    echo "entrypoint: refreshed profile failed validation (see /data/logs/dump-config.err.log); restored the previous install. Not starting." >&2
    exit 3
  fi
}

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
  cp "$PATCH_SRC" "$PATCH_DST"
  sha256_of "$PATCH_SRC" > "$PATCH_STAMP"
  log "re-linking stack packages into the profile..."
  relink_stack /data/dsh/profiles/agent || exit 3
  cp "$SKEL_ID_SRC" "$SKEL_ID_STAMP"

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
refresh_profile_install
refresh_profile_patch
validate_refresh
log "starting supervisor tree..."
exec /usr/bin/supervisord -c /opt/agent/supervisord.conf
