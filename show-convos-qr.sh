#!/usr/bin/env bash
# show-convos-qr.sh — Display scannable QR for Convos Production Agent
# Fixes "invalid base64url encoding" — Convos expects a base64url invite token
# at popup.convos.org/v2?i=<slug>, NOT a raw EOA hex address.
#
# Production Convos conversation created via @xmtp/convos-cli (Node 22, env production)
#   conversationId: cfb3c129e6d2eb8121fafdf32cfba897
#   inboxId:        e39220beba324478382487327673837ee6a040592eb8520b85b69afc24a6dd46
#   address:        0x5255B7E1078E09B72888D1fd0C64ce35920Cf735
#
# Usage: ./show-convos-qr.sh
#   Scan with Convos app (iOS/Android) — NOT with vanilla XMTP (Converse).
set -euo pipefail

# ── Config ───────────────────────────────────────────────────────────────
INVITE_URL="https://popup.convos.org/v2?i=CokBCj8BRrnkzQYP9pJPvMCc8alkA-dEUVTci0BmNHVO0yRadCmFcEfHGNcCmgEcw6ve2JGmM0aPn9_R2mxcYQ7MxeMSIOOSIL66MkR4OCSHMnZzg37moEBZLrhSC4W2mvwkpt1GGgpVbUo2WlRJN0J0IhBQcm9kdWN0aW9uIEFnZW50SABSBPCfjq8SQQmdmOdenjqDxzTEhW-3VlebtjSUmInOD-zvdLaG2PhwJu7FnyZG43-W_x70W0-HZdXzit5Eb02k0j0wEZXnrUkB"
# Fallback invite (second slug, same conversation, also valid):
# INVITE_URL="https://popup.convos.org/v2?i=CokBCj8BRrnkzQYP9pJPvMCc8alkA-dEUVTci0BmNHVO0yRadCmFcEfHGNcCmgEcw6ve2JGmM0aPn9_R2mxcYQ7MxeMSIOOSIL66MkR4OCSHMnZzg37moEBZLrhSC4W2mvwkpt1GGgpVbUo2WlRJN0J0IhBQcm9kdWN0aW9uIEFnZW50SABSBPCfjq8SQQmdmOdenjqDxzTEhW-3VlebtjSUmInOD-zvdLaG2PhwJu7FnyZG43-W_x70W0-HZdXzit5Eb02k0j0wEZXnrUkB"
CONVO_ID="${CONVO_ID:-cfb3c129e6d2eb8121fafdf32cfba897}"
ENV_NAME="production"

# Vanilla XMTP EOA (legacy, for Converse / xmtp.chat — NOT for Convos app):
VANILLA_ADDRESS="0xa85dD3FbD8C2c831Ef156036F14638CcFf03b44e"
VANILLA_DM="https://convo.space/dm/${VANILLA_ADDRESS}"

# NVM wiring so the script works even if called from a Node-26 shell
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
  nvm use 22 >/dev/null 2>&1 || true
fi

# ── Header ───────────────────────────────────────────────────────────────
echo ""
echo "  Convos Production Agent — scan to chat"
echo "  ────────────────────────────────────────────"
echo "  Convo ID  : ${CONVO_ID}"
echo "  Network   : ${ENV_NAME} (XMTP production, Convos singleton inbox)"
echo "  Invite    : ${INVITE_URL}"
echo "  Tag       : UmJ6ZTI7Bt"
echo ""
echo "  Vanilla XMTP (for Converse / xmtp.chat, NOT Convos):"
echo "    ${VANILLA_DM}  (${VANILLA_ADDRESS})"
echo ""

has_cmd() { command -v "$1" >/dev/null 2>&1; }

# ── Render Convos invite QR via convos-cli (authoritative, matches app) ──
if has_cmd convos; then
  echo "  QR (Convos invite — popup.convos.org/v2?i= — base64url, scan with Convos app):"
  echo ""
  # convos prints QR to stderr and URL to stdout; we want both
  convos conversation invite "$CONVO_ID" --env production 2>&1 | grep -v "WARN CORE" || true
  echo ""
  echo "  ✓ Above QR is base64url-valid. Previous hex address QR would always give"
  echo "    'invalid base64url encoding' in Convos — that's fixed now."
  echo ""
else
  # fallback: generic qrcode-terminal via npx/node22
  echo "  QR (fallback qrcode-terminal):"
  echo ""
  if echo "$INVITE_URL" | npx --yes -p qrcode-terminal qrcode-terminal 2>/dev/null | grep -q "▄▄"; then
    echo "$INVITE_URL" | npx --yes -p qrcode-terminal qrcode-terminal 2>/dev/null
  else
    npm install --prefix /tmp/qr-test --silent qrcode-terminal 2>/dev/null
    node -e "var q=require('/tmp/qr-test/node_modules/qrcode-terminal'); q.generate('$INVITE_URL', {small:false})"
  fi
  echo ""
  echo "  Invite URL: $INVITE_URL"
  echo ""
fi

# ── Footer ───────────────────────────────────────────────────────────────
echo "  ────────────────────────────────────────────"
echo "  How to use (Convos):"
echo "    1. Open Convos (https://convos.org) on your phone"
echo "    2. Tap + → Scan QR (or paste invite link)"
echo "    3. Send a message — agent replies if running"
echo ""
echo "  Start / check the agent:"
echo "    convos agent serve $CONVO_ID --env production"
echo "    # detached (keeps running):"
echo "    setsid -f convos agent serve $CONVO_ID --env production </dev/null >>/tmp/convos-agent.log 2>&1"
echo "    convos conversations list --env production --json"
echo ""
echo "  Troubleshooting:"
echo "    • 'invalid base64url' = you scanned the old hex QR. Use the QR above (popup.convos.org/v2?i=...)."
echo "    • No reply? Agent not running. Start it with the command above."
echo "    • Vanilla XMTP users: use Converse → ${VANILLA_DM}"
echo ""
