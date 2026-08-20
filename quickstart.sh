#!/bin/bash
set -euo pipefail
# quickstart.sh — one-shot get-started for dsh-haven web3 agent
# Up-to-date with 02ca906 (xmtp unblock deliveries, wallet-tools minimal prepare) + 94e6ebf/84c1720 + persona generic wallet_info
# Builds, tests, starts xmtp-prod (0ddc475555c17970da3bb476f4dfe2ab7f76c9829df42341538b1feb017f90aa / 0xa85dD3FbD8C2c831Ef156036F14638CcFf03b44e, production), spits Convos QR + wallet
# Usage: bash quickstart.sh  (or: MUSE_SPARK_API_KEY=... bash quickstart.sh)

# Prefer persisted key from bashrc/credentials so a stale shell env doesn't keep an old revoked key
set +u
if [ -f "$HOME/.bashrc" ]; then
  # shellcheck disable=SC1090
  . "$HOME/.bashrc" 2>/dev/null || true
fi
set -u
if [ -f "$HOME/.dsh/.credentials.yaml" ]; then
  _CRED_KEY=$(grep -E "MUSE_SPARK_API_KEY" "$HOME/.dsh/.credentials.yaml" 2>/dev/null | awk '{print $2}' | tr -d '"' | head -n1 || true)
  if [ -n "${_CRED_KEY:-}" ]; then
    export MUSE_SPARK_API_KEY="$_CRED_KEY"
  fi
fi
unset _CRED_KEY 2>/dev/null || true

if [ -z "${MUSE_SPARK_API_KEY:-}" ]; then
  echo "MUSE_SPARK_API_KEY is required. Get one from Muse Spark and run: MUSE_SPARK_API_KEY=<your-key> bash quickstart.sh" >&2
  exit 1
fi

STACK="$(cd "$(dirname "$0")" && pwd)"
PROFILE=xmtp-prod
LOG=/tmp/dsh-xmtp-prod.log
CONVOS_HOME_TMP=${CONVOS_HOME_TMP:-/tmp/convos-tester}
OWS_VAULT_DIR="${OWS_VAULT_DIR:-$HOME/.ows}"
OWS_WALLET_NAME="xmtp-agent"
OWS_NODE_BIN="/root/.nvm/versions/node/v22.23.2/bin/node"
OWS_PROFILE_NODE_PATH="/root/.dsh/profiles/xmtp-prod/node_modules"

# --- OWS wallet setup / reuse with Y/N permission ---
echo "== OWS vault check ($OWS_VAULT_DIR) =="
OWS_WALLET_FILE=""
if ls "$OWS_VAULT_DIR/wallets"/*.json >/dev/null 2>&1; then
  OWS_WALLET_FILE=$(grep -l "\"name\": \"${OWS_WALLET_NAME}\"" "$OWS_VAULT_DIR/wallets"/*.json 2>/dev/null | head -n 1 || true)
fi
OWS_ADDR=""
if [ -n "${OWS_WALLET_FILE:-}" ] && [ -f "$OWS_WALLET_FILE" ]; then
  OWS_ADDR=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); addrs=[a['address'] for a in d['accounts'] if a.get('chain_id','').startswith('eip155:')]; print(addrs[0] if addrs else d['accounts'][0]['address'])" "$OWS_WALLET_FILE" 2>/dev/null || grep -o '"address": "0x[^"]*"' "$OWS_WALLET_FILE" | head -n1 | cut -d'"' -f4)
  OWS_ID=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['id'])" "$OWS_WALLET_FILE" 2>/dev/null || basename "$OWS_WALLET_FILE" .json)
  echo "Found existing OWS wallet '$OWS_WALLET_NAME' id $OWS_ID address $OWS_ADDR"
  ANS=""
  if [ -t 0 ]; then
    read -r -p "Reuse existing OWS wallet '$OWS_WALLET_NAME' ($OWS_ADDR)? [Y/n] " ANS || true
    ANS=${ANS:-Y}
  else
    ANS=Y
    echo "(non-interactive stdin, auto-answering Y to reuse)"
  fi
  if [[ "$ANS" =~ ^[Yy]$ ]]; then
    echo "Reusing OWS wallet $OWS_WALLET_NAME ($OWS_ADDR)"
  else
    echo "User declined reuse."
    ANS2=""
    if [ -t 0 ]; then
      read -r -p "Create a NEW wallet to replace '$OWS_WALLET_NAME'? This deletes the old vault file. [y/N] " ANS2 || true
      ANS2=${ANS2:-N}
    else
      ANS2=N
    fi
    if [[ "$ANS2" =~ ^[Yy]$ ]]; then
      echo "Deleting old wallet file $OWS_WALLET_FILE ..."
      rm -f "$OWS_WALLET_FILE"
      echo "Creating new OWS wallet '$OWS_WALLET_NAME' (no passphrase, experimental)..."
      CREATED_JSON=$(NODE_PATH="$OWS_PROFILE_NODE_PATH" "$OWS_NODE_BIN" -e "const ows=require('@open-wallet-standard/core'); const w=ows.createWallet('$OWS_WALLET_NAME'); console.log(JSON.stringify(w))" 2>&1)
      if [ $? -ne 0 ] || [ -z "$CREATED_JSON" ]; then
        echo "Failed to create OWS wallet: $CREATED_JSON" >&2
        exit 1
      fi
      # re-detect file
      OWS_WALLET_FILE=$(grep -l "\"name\": \"${OWS_WALLET_NAME}\"" "$OWS_VAULT_DIR/wallets"/*.json 2>/dev/null | head -n 1 || true)
      OWS_ADDR=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); addrs=[a['address'] for a in d['accounts'] if a.get('chain_id','').startswith('eip155:')]; print(addrs[0] if addrs else d['accounts'][0]['address'])" "$OWS_WALLET_FILE" 2>/dev/null || echo "$CREATED_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print([a['address'] for a in d['accounts'] if a['chain_id'].startswith('eip155:')][0])" 2>/dev/null || echo "unknown")
      echo "Created new wallet '$OWS_WALLET_NAME' address $OWS_ADDR"
      echo "NOTE: XMTP inboxId is derived from this wallet. If you replace the wallet, update any hardcoded inboxIds and recreate Convos invites."
    else
      echo "Aborting per user request (no wallet to run agent)." >&2
      exit 1
    fi
  fi
else
  echo "No OWS wallet '$OWS_WALLET_NAME' found in $OWS_VAULT_DIR/wallets"
  ANS=""
  if [ -t 0 ]; then
    read -r -p "Create OWS wallet '$OWS_WALLET_NAME' now? [y/N] " ANS || true
    ANS=${ANS:-N}
  else
    ANS=N
    echo "(non-interactive, skipping creation prompt -> will attempt to continue; agent will fail if wallet required)"
  fi
  if [[ "$ANS" =~ ^[Yy]$ ]]; then
    echo "Creating new OWS wallet '$OWS_WALLET_NAME'..."
    CREATED_JSON=$(NODE_PATH="$OWS_PROFILE_NODE_PATH" "$OWS_NODE_BIN" -e "const ows=require('@open-wallet-standard/core'); const w=ows.createWallet('$OWS_WALLET_NAME'); console.log(JSON.stringify(w))" 2>&1)
    if [ $? -ne 0 ] || [ -z "$CREATED_JSON" ]; then
      echo "Failed to create OWS wallet: $CREATED_JSON" >&2
      exit 1
    fi
    OWS_WALLET_FILE=$(grep -l "\"name\": \"${OWS_WALLET_NAME}\"" "$OWS_VAULT_DIR/wallets"/*.json 2>/dev/null | head -n 1 || true)
    OWS_ADDR=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); addrs=[a['address'] for a in d['accounts'] if a.get('chain_id','').startswith('eip155:')]; print(addrs[0] if addrs else d['accounts'][0]['address'])" "$OWS_WALLET_FILE" 2>/dev/null || echo "$CREATED_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print([a['address'] for a in d['accounts'] if a['chain_id'].startswith('eip155:')][0])" 2>/dev/null || echo "unknown")
    echo "Created wallet '$OWS_WALLET_NAME' address $OWS_ADDR"
  else
    echo "Skipping OWS creation - agent start will fail if '$OWS_WALLET_NAME' is required (wallet seam)." >&2
    # leave OWS_ADDR empty, continue to let later step fail visibly
  fi
fi
# dynamic wallet display (if we have an address, use it; else fall back)
if [ -n "${OWS_ADDR:-}" ]; then
  echo "OWS wallet ready: $OWS_WALLET_NAME -> $OWS_ADDR"
fi

# --- Debugging mode Y/N — traces readable in workspace dir ---
DEBUG_DIR="$STACK/debug"
DEBUG_MODE="0"
if [ -t 0 ]; then
  ANS_DBG=""
  read -r -p "Enable debugging mode (write traces to $DEBUG_DIR for assistant to read)? [y/N] " ANS_DBG || true
  ANS_DBG=${ANS_DBG:-N}
  if [[ "$ANS_DBG" =~ ^[Yy]$ ]]; then DEBUG_MODE="1"; fi
else
  # non-interactive: respect DEBUG env, default N
  if [ "${DEBUG:-}" = "1" ] || [ "${DEBUG_MODE_ENV:-}" = "1" ]; then DEBUG_MODE="1"; fi
  if [ "$DEBUG_MODE" = "1" ]; then echo "(non-interactive DEBUG=1, enabling debugging traces)"; else echo "(non-interactive, debugging traces off)"; fi
fi
if [ "$DEBUG_MODE" = "1" ]; then
  mkdir -p "$DEBUG_DIR"
  # expose session traces + logs inside workspace so assistant can read without host paths
  # symlink live sessions and storages, plus tail logs
  rm -rf "$DEBUG_DIR/sessions" "$DEBUG_DIR/storages" "$DEBUG_DIR/logs"
  mkdir -p "$DEBUG_DIR/logs"
  ln -sf /root/.dsh/sessions "$DEBUG_DIR/sessions" 2>/dev/null || cp -a /root/.dsh/sessions "$DEBUG_DIR/sessions" 2>/dev/null || true
  ln -sf /root/.dsh/storages "$DEBUG_DIR/storages" 2>/dev/null || true
  ln -sf /tmp/dsh-xmtp-prod.log "$DEBUG_DIR/logs/agent.log" 2>/dev/null || true
  ln -sf /tmp/convos-join-watcher.log "$DEBUG_DIR/logs/join-watcher.log" 2>/dev/null || true
  # live copy helper: background tail that mirrors logs into debug dir
  cat > "$DEBUG_DIR/README.md" << 'DBGREADME'
# Debug traces (quickstart debugging mode)
This directory mirrors live traces for assistant debugging. `sessions/` and `storages/` are symlinks to `/root/.dsh/*`; `logs/` mirrors `/tmp/*.log`.
Assistant can `zstdcat debug/sessions/**/session.jsonl.zstd | tail` or `cat debug/logs/agent.log` directly in workspace without host paths.
DBGREADME
  echo "Debugging mode ON: traces available at $DEBUG_DIR (sessions/, logs/agent.log)"
  export DEBUG="1"
  export DSH_DEBUG="1"
else
  echo "Debugging mode off (run with DEBUG=1 or answer y to enable traces in $DEBUG_DIR)"
fi

echo "== Building latest stack =="
cd "$STACK/dsh-channel-xmtp" && npx tsdown 2>&1 | grep -E "Build complete|ERROR" | tail -n 5
cd "$STACK/dsh-wallet-tools" && npx tsdown 2>&1 | grep -E "Build complete|ERROR" | tail -n 5
cd "$STACK" && npx vitest run 2>&1 | grep -E "Test Files|Tests"

echo ""
echo "== Starting $PROFILE (inbox 0ddc475555c17970da3bb476f4dfe2ab7f76c9829df42341538b1feb017f90aa / 0xa85dD3FbD8C2c831Ef156036F14638CcFf03b44e) =="
pkill -f "xmtp-prod" 2>/dev/null || true
sleep 2
rm -f "$LOG"
setsid -f /bin/bash -c "exec env MUSE_SPARK_API_KEY=$MUSE_SPARK_API_KEY /root/.nvm/versions/node/v22.23.2/bin/node /root/deepseek-harness/apps/cli/lib/bin.js --profile $PROFILE >>$LOG 2>&1"
sleep 8
if ! ps -o pid,args | grep -q "xmtp-prod"; then
  echo "Failed to start, log:"
  cat "$LOG" | tail -n 30
  exit 1
fi
echo "Agent PID $(ps -o pid,args | grep xmtp-prod | grep -v grep | awk '{print $1}') live"

echo ""
echo "== Wallet (dynamic via wallet_info -> ctx.wallet.address) =="
if [ -n "${OWS_ADDR:-}" ]; then
  echo "Agent wallet $OWS_WALLET_NAME: address $OWS_ADDR (OWS vault $OWS_WALLET_NAME, chain evm->ethereum)"
  echo "To fund: send USDC/USDFC or native gas to $OWS_ADDR on Filecoin FEVM / Ethereum"
else
  # fallback: query via OWS directly
  FALLBACK_ADDR=$(NODE_PATH="$OWS_PROFILE_NODE_PATH" "$OWS_NODE_BIN" -e "try{const ows=require('@open-wallet-standard/core'); const w=ows.getWallet('$OWS_WALLET_NAME'); const a=w.accounts.find(x=>x.chain_id.startsWith('eip155:')); console.log(a?a.address:w.accounts[0].address)}catch(e){console.log('')}" 2>/dev/null || true)
  if [ -n "$FALLBACK_ADDR" ]; then
    echo "Agent wallet $OWS_WALLET_NAME: address $FALLBACK_ADDR (OWS vault $OWS_WALLET_NAME, chain evm->ethereum)"
    echo "To fund: send USDC/USDFC or native gas to $FALLBACK_ADDR on Filecoin FEVM / Ethereum"
  else
    echo "Agent wallet $OWS_WALLET_NAME: address unknown (OWS vault not found)"
  fi
fi

echo ""
echo "== Convos QR (production) =="
# auto-approve Convos invite scans (DM join requests) — needed so QR "waiting for approval" clears without manual step
JOIN_LOG=/tmp/convos-join-watcher.log
pkill -f "process-join-requests.*--watch" 2>/dev/null || true
setsid -f /bin/bash -c "exec env CONVOS_HOME=$CONVOS_HOME_TMP convos conversations process-join-requests --env production --watch >>$JOIN_LOG 2>&1"
sleep 3
if ! ps -o pid,args | grep -q "process-join-requests.*--watch"; then
  echo "Join watcher failed, log:"
  cat "$JOIN_LOG" | tail -n 20
fi
echo "Join watcher PID $(ps -o pid,args | grep "process-join-requests.*--watch" | grep -v grep | awk '{print $1}') live (log $JOIN_LOG)"

NEW=$(CONVOS_HOME=$CONVOS_HOME_TMP convos conversations create --name "qr-$(date +%s)" --env production 2>&1 | grep conversationId | awk '{print $2}')
echo "Conversation $NEW (2 members after add)"
CONVOS_HOME=$CONVOS_HOME_TMP convos conversation add-members $NEW 0ddc475555c17970da3bb476f4dfe2ab7f76c9829df42341538b1feb017f90aa --env production 2>&1 | grep -E "success|addedInboxIds"
INVITE=$(CONVOS_HOME=$CONVOS_HOME_TMP convos conversation invite $NEW --env production 2>&1 | grep -E "https://popup" | head -n 1 | awk '{print $1}')
if [ -z "$INVITE" ]; then
  INVITE=$(grep -E "convosInviteUrl" /root/.dsh/profiles/xmtp-prod/cordis.patch.yml | sed 's/.*https/https/' | tr -d '"')
fi
echo ""
echo "Invite URL: $INVITE"
if command -v qrencode >/dev/null 2>&1; then
  echo ""
  qrencode -t ANSIUTF8 -m 2 -o - "$INVITE"
  echo ""
else
  echo "(install qrencode to see ANSI QR: sudo apt-get install qrencode)"
  echo "Scan the URL above at https://popup.convos.org"
fi

echo ""
echo "== Test it =="
echo "CONVOS_HOME=$CONVOS_HOME_TMP convos conversation send-text $NEW --env production --text \"Hi my name is TestUser\""
echo "CONVOS_HOME=$CONVOS_HOME_TMP convos conversation send-text $NEW --env production --text \"what is your wallet address?\""
echo "CONVOS_HOME=$CONVOS_HOME_TMP convos conversation messages $NEW --env production"
echo ""
echo "Log: tail -f $LOG  |  tail -f $JOIN_LOG"
echo "Stop: pkill -f xmtp-prod; pkill -f process-join-requests"
