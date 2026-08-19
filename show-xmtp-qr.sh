#!/usr/bin/env bash
# show-xmtp-qr.sh — Display a scannable QR for the production XMTP agent
# Production agent: 0xa85dD3FbD8C2c831Ef156036F14638CcFf03b44e (env: production)
# Profile: xmtp-prod (dsh-channel-xmtp, wallet xmtp-agent)
#
# Usage: ./show-xmtp-qr.sh
#   Scans with Convo (https://convo.space) to start a DM.
#   Also works with Converse, Coinbase Wallet, and any XMTP client.
#
# Override: ADDRESS=0x... ./show-xmtp-qr.sh
#           DM_URL=https://convo.space/dm/0x... ./show-xmtp-qr.sh
set -euo pipefail

# ── Config ───────────────────────────────────────────────────────────────
ADDRESS="${ADDRESS:-0xa85dD3FbD8C2c831Ef156036F14638CcFf03b44e}"
ENV_NAME="${ENV_NAME:-production}"
# Convo deep link — the QR payload. Convo, Converse and xmtp.chat all
# resolve an EOA address to the same inbox on the given XMTP network.
DM_URL="${DM_URL:-https://convo.space/dm/${ADDRESS}}"
ALT_URL="https://converse.xyz/dm/${ADDRESS}"
XIP_URL="https://xmtp.chat/dm/${ADDRESS}"

# ── Header ───────────────────────────────────────────────────────────────
echo ""
echo "  XMTP Production Agent — scan to chat"
echo "  ─────────────────────────────────────"
echo "  Address : ${ADDRESS}"
echo "  Network : ${ENV_NAME}  (XMTP production)"
echo "  Profile : xmtp-prod (channel-xmtp / wallet xmtp-agent)"
echo "  Convo   : ${DM_URL}"
echo "  Alt     : ${ALT_URL}"
echo ""

# ── Helpers ──────────────────────────────────────────────────────────────
has_cmd() { command -v "$1" >/dev/null 2>&1; }

# 1) native qrencode (fastest, best ANSI rendering)
try_qrencode() {
  if has_cmd qrencode; then
    echo "  QR (qrencode ANSIUTF8):"
    echo ""
    qrencode -t ANSIUTF8 -m 2 -o - "${DM_URL}"
    echo ""
    return 0
  fi
  return 1
}

# 2) npx qrcode-terminal (no install needed, fetches on demand)
try_npx() {
  if has_cmd npx && has_cmd node; then
    echo "  QR (npx qrcode-terminal):"
    echo ""
    # The bin checks isTTY — pipe via stdin for non-TTY harnesses,
    # direct arg for interactive TTYs. Try piped first, then arg.
    if echo "${DM_URL}" | npx --yes -p qrcode-terminal qrcode-terminal 2>/dev/null | grep -q "▄▄"; then
      echo "${DM_URL}" | npx --yes -p qrcode-terminal qrcode-terminal 2>/dev/null
      echo ""
      return 0
    fi
    if npx --yes -p qrcode-terminal qrcode-terminal "${DM_URL}" 2>/dev/null | grep -q "▄▄"; then
      npx --yes -p qrcode-terminal qrcode-terminal "${DM_URL}" 2>/dev/null
      echo ""
      return 0
    fi
    # fallback: use already-fetched module via node (works without TTY)
    if [ -d /tmp/qr-test/node_modules/qrcode-terminal ]; then
      node -e "var q=require('/tmp/qr-test/node_modules/qrcode-terminal'); q.generate('${DM_URL}', {small:true})" 2>/dev/null | grep -q "▄▄" && {
        node -e "var q=require('/tmp/qr-test/node_modules/qrcode-terminal'); q.generate('${DM_URL}', {small:true})"
        echo ""
        return 0
      }
    fi
    # last resort: install to /tmp and render
    npm install --prefix /tmp/qr-test --silent qrcode-terminal 2>/dev/null && \
      node -e "var q=require('/tmp/qr-test/node_modules/qrcode-terminal'); q.generate('${DM_URL}', {small:true})" && {
      echo ""
      return 0
    }
  fi
  return 1
}

# 3) python3 + qrcode[pil] (pip auto-install into user site)
try_python() {
  if has_cmd python3; then
    # ensure qrcode is available — install quietly to user site if missing
    if ! python3 -c "import qrcode" 2>/dev/null; then
      echo "  Installing python qrcode (pip --user, one-time)…"
      python3 -m pip install --user --quiet "qrcode[pil]" 2>&1 | tail -n 5 || true
    fi
    if python3 -c "import qrcode" 2>/dev/null; then
      echo "  QR (python qrcode — ANSI):"
      echo ""
      DM_URL="${DM_URL}" python3 <<'PY'
import os, sys
try:
    import qrcode
except ImportError:
    print("python qrcode not available — install with: pip install 'qrcode[pil]'")
    sys.exit(1)

url = os.environ.get("DM_URL", "")
qr = qrcode.QRCode(border=2)
qr.add_data(url)
qr.make(fit=True)
# print_tty renders ANSI blocks directly to terminal (no image file needed)
qr.print_tty()
print()
PY
      # also write a PNG for sharing / preview if pillow is present
      DM_URL="${DM_URL}" python3 <<'PY' 2>/dev/null || true
import os
try:
    import qrcode
    url = os.environ.get("DM_URL","")
    img = qrcode.make(url)
    out = "/tmp/xmtp-qr.png"
    img.save(out)
    print(f"  PNG also saved to {out} — open with: xdg-open {out} / open {out}")
except Exception as e:
    pass
PY
      echo ""
      return 0
    fi
  fi
  return 1
}

# ── Render ───────────────────────────────────────────────────────────────
if try_qrencode; then
  :
elif try_npx; then
  :
elif try_python; then
  :
else
  echo "  No QR renderer found."
  echo "  Install one of:"
  echo "    sudo apt-get install qrencode          # native"
  echo "    pip install 'qrcode[pil]'              # python"
  echo "    # or ensure node + npx is available"
  echo ""
  echo "  URL to encode manually: ${DM_URL}"
  exit 1
fi

# ── Footer ───────────────────────────────────────────────────────────────
echo "  ─────────────────────────────────────"
echo "  How to use:"
echo "    1. Open Convo (https://convo.space) on your phone"
echo "       — or Converse / Coinbase Wallet / any XMTP app"
echo "    2. Tap Scan QR / New conversation → Scan"
echo "    3. Point at the QR above"
echo "    4. Send a message — the agent replies via dsh-channel-xmtp"
echo ""
echo "  Verify the agent is running:"
echo "    dsh profile --profile xmtp-prod status   # or: dsh up --profile xmtp-prod"
echo "    Logs: tail -f /tmp/xmtp-db*  (db)  and dsh logs"
echo ""
echo "  Troubleshooting:"
echo "    • Wrong network? This QR is XMTP production. Dev/local peers won't see it."
echo "    • No reply? Check the agent has MUSE_SPARK_API_KEY set and the profile is up."
echo "    • Raw address for manual entry: ${ADDRESS}"
echo ""
