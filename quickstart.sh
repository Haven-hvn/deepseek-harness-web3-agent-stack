#!/bin/bash
set -euo pipefail
# quickstart.sh — one-shot get-started for dsh-haven web3 agent
# Up-to-date with 02ca906 (xmtp unblock deliveries, wallet-tools minimal prepare) + 94e6ebf/84c1720 + persona generic wallet_info
# Builds, tests, starts xmtp-prod (0ddc475555c17970da3bb476f4dfe2ab7f76c9829df42341538b1feb017f90aa / 0xa85dD3FbD8C2c831Ef156036F14638CcFf03b44e, production), spits Convos QR + wallet
# Usage: bash quickstart.sh  (or: MUSE_SPARK_API_KEY=... bash quickstart.sh)

if [ -z "${MUSE_SPARK_API_KEY:-}" ]; then
  echo "MUSE_SPARK_API_KEY is required. Get one from Muse Spark and run: MUSE_SPARK_API_KEY=<your-key> bash quickstart.sh" >&2
  exit 1
fi

STACK="$(cd "$(dirname "$0")" && pwd)"
PROFILE=xmtp-prod
LOG=/tmp/dsh-xmtp-prod.log
CONVOS_HOME_TMP=${CONVOS_HOME_TMP:-/tmp/convos-tester}

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
echo "Agent wallet agent: address 0xa85dD3FbD8C2c831Ef156036F14638CcFf03b44e (OWS vault xmtp-agent, chain evm->ethereum)"
echo "To fund: send USDC/USDFC or native gas to 0xa85dD3FbD8C2c831Ef156036F14638CcFf03b44e on Filecoin FEVM / Ethereum"

echo ""
echo "== Convos QR (production) =="
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
echo "Log: tail -f $LOG"
echo "Stop: pkill -f xmtp-prod"
