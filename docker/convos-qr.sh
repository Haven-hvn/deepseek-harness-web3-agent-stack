#!/bin/sh
# convos-qr.sh — idempotent Convos invite + QR for the agent.
# Waits for the agent's XMTP db, then mints (or reuses) a group conversation
# with the agent's inbox and prints the invite URL + QR. Never fails the
# container: diagnostics + DM fallback on any error, exit 0 always.
set -eu

log() { echo "convos-qr: $*"; }
fallback() {
  log "$1"
  log "DM fallback: message the agent EVM address from any XMTP client:"
  log "  $(cat /data/keys/evm.address 2>/dev/null || echo '<keys missing>')"
  exit 0
}

for _ in $(seq 1 90); do
  [ -f /data/xmtp/agent.db ] && break
  sleep 10
done
[ -f /data/xmtp/agent.db ] || fallback "agent XMTP db never appeared; is the agent up?"
sleep 10

export CONVOS_HOME=/data/convos
mkdir -p /data/convos
INBOX=$(cat /data/keys/inbox.id)
# Messaging env must match the agent channel (production everywhere in this
# stack): an invite minted on dev is invisible to the production app
# ("no convos here"). Override per-call with CONVOS_ENV if ever needed.
CONVOS_ENV="${CONVOS_ENV:-production}"
# NOTE: `conversations create` takes no members positional (it creates an MLS
# group in this install's inbox; identity is auto-created if missing) —
# members join via add-members + invite below. An earlier revision passed
# "$SELF/$INBOX" positionally, which the CLI rejects as an unknown command.

if [ ! -f /data/convos/convo.id ]; then
  log "creating group conversation (env $CONVOS_ENV)..."
  CREATE_OUT=$(convos conversations create --name "Agent Chat" --env "$CONVOS_ENV" 2>&1) || fallback "create failed: $CREATE_OUT"
  CONVO=$(printf '%s' "$CREATE_OUT" | grep -oE "conversation[^']*'[^']*'" | head -n 1 | sed "s/.*'//;s/'//")
  [ -z "$CONVO" ] && CONVO=$(printf '%s' "$CREATE_OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f-]{27,}' | head -n 1)
  [ -z "$CONVO" ] && CONVO=$(printf '%s' "$CREATE_OUT" | grep -oE 'conversationId[[:space:]]+[0-9a-f]{32}' | grep -oE '[0-9a-f]{32}$' | head -n 1)
  [ -z "$CONVO" ] && fallback "could not parse conversation id from: $CREATE_OUT"
  printf '%s' "$CONVO" > /data/convos/convo.id
  log "conversation $CONVO"
  convos conversation add-members "$CONVO" "$INBOX" --env "$CONVOS_ENV" >/dev/null 2>&1 \
    || log "add-members warning (continuing)"
else
  CONVO=$(cat /data/convos/convo.id)
  log "reusing conversation $CONVO"
fi

INVITE_OUT=$(convos conversation invite "$CONVO" --env "$CONVOS_ENV" 2>/tmp/invite.err; echo "rc=$?") || true
URL=$(printf '%s' "$INVITE_OUT" | grep -oE 'https://[^ ]*' | head -n 1)
[ -z "$URL" ] && fallback "invite minting failed; see logs."
echo ""
echo "Convos invite: $URL"
echo ""
if command -v qrencode >/dev/null 2>&1; then
  qrencode -t ANSIUTF8 -m 2 "$URL"
else
  cat /tmp/invite.err 2>/dev/null | head -40
fi
echo ""
exit 0
