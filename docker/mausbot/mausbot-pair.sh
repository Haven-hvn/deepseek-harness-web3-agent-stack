#!/bin/sh
# mausbot-pair.sh — Wait for the OpenMausBot server on container loopback, then
# mint and print a fresh one-time pairing code + sign-in link (and QR when
# OMB_PUBLIC_URL is set to the host address reachable by phone/desktop).
# Non-fatal: logs diagnostics and exits 0 always so the container stays
# healthy. Re-run any time with: docker exec <container> openmausbot pair
set -eu

PORT="${OMB_PORT:-8799}"
log() { echo "mausbot-pair: $*"; }

ready=0
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${PORT}/api/health" 2>/dev/null | grep -q openmausbot; then
    ready=1
    break
  fi
  sleep 2
done

if [ "$ready" != "1" ]; then
  log "OpenMausBot server did not answer on http://127.0.0.1:${PORT}/api/health within 120s; skipping initial pairing code"
  exit 0
fi

echo ""
echo "================================================================"
echo "OpenMausBot Web GUI is ready."
echo "Mint a new code later with:  docker exec <container> openmausbot pair"
echo "================================================================"
set -- --port "$PORT"
# Without a non-loopback public URL the CLI prints a code but no phone
# link/QR. Pass it explicitly so the initial code works from another device.
if [ -n "${OMB_PUBLIC_URL:-}" ]; then
  set -- "$@" --public-url "$OMB_PUBLIC_URL"
fi
/usr/local/bin/openmausbot pair "$@" || log "pair command returned non-zero (run 'openmausbot pair' manually)"
echo ""
exit 0
