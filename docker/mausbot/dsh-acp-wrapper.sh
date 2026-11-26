#!/bin/sh
# dsh-acp-wrapper.sh — CLI entrypoint OpenMausBot invokes for the Haven Web3
# DeepSeek Harness engine.
#
# - Preserves stdout untouched for `--version` / `--help` / `--dump-config`
#   probes so OpenMausBot's version check succeeds.
# - Loads persisted container service keys (Prowlarr + optional custom model
#   settings) without overriding values explicitly set in OpenMausBot Settings.
# - Preloads `acp-stdout-guard.mjs` when running the `acp` profile so plugin
#   `console.log` calls go to stderr and never corrupt ACP JSON-RPC framing.
# - Preloads `no-body-timeout.cjs` so undici's 300 s body/header timeout never
#   kills a slow local-model turn (the one-hour OMB_* timers bound it instead).
set -eu

export DSH_HOME="${DSH_HOME:-/data/dsh}"
export DSH_TELEMETRY_DISABLED=1

if [ -z "${PROWLARR_API_KEY:-}" ] && [ -r /data/keys/prowlarr.key ]; then
  PROWLARR_API_KEY=$(cat /data/keys/prowlarr.key)
  export PROWLARR_API_KEY
fi

# Fill missing model env vars from /data/keys/model.env (written by entrypoint.sh
# when the container starts with MODEL_* / DEEPSEEK_API_KEY) without clobbering
# anything OpenMausBot explicitly injected.
if [ -r /data/keys/model.env ]; then
  SAVED_MODEL_BASE_URL="${MODEL_BASE_URL:-}"
  SAVED_MODEL_ID="${MODEL_ID:-}"
  SAVED_MODEL_API_KEY="${MODEL_API_KEY:-}"
  SAVED_MODEL_API_PROTOCOL="${MODEL_API_PROTOCOL:-}"
  SAVED_DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-}"
  # shellcheck disable=SC1091
  . /data/keys/model.env
  [ -n "$SAVED_MODEL_BASE_URL" ] && MODEL_BASE_URL="$SAVED_MODEL_BASE_URL"
  [ -n "$SAVED_MODEL_ID" ] && MODEL_ID="$SAVED_MODEL_ID"
  [ -n "$SAVED_MODEL_API_KEY" ] && MODEL_API_KEY="$SAVED_MODEL_API_KEY"
  [ -n "$SAVED_MODEL_API_PROTOCOL" ] && MODEL_API_PROTOCOL="$SAVED_MODEL_API_PROTOCOL"
  [ -n "$SAVED_DEEPSEEK_API_KEY" ] && DEEPSEEK_API_KEY="$SAVED_DEEPSEEK_API_KEY"
  export MODEL_BASE_URL MODEL_ID MODEL_API_KEY MODEL_API_PROTOCOL DEEPSEEK_API_KEY
fi

# Detect ACP stdio invocation (skip guard on --version / --help / --dump-*).
is_acp=0
is_meta=0
prev=""
for arg in "$@"; do
  case "$arg" in
    -V|--version|-h|--help|--dump-config|--dump-default-config|--dump-config-schema)
      is_meta=1 ;;
    acp)
      if [ "$prev" = "--profile" ] || [ -z "$prev" ]; then
        is_acp=1
      fi ;;
    --profile=acp)
      is_acp=1 ;;
  esac
  prev="$arg"
done

if [ "$is_acp" = "1" ] && [ "$is_meta" = "0" ]; then
  export NODE_OPTIONS="--import /opt/agent/acp-stdout-guard.mjs --require /opt/agent/no-body-timeout.cjs ${NODE_OPTIONS:-}"
fi

exec dsh "$@"
