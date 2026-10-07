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

if ! SELF=$(convos identity show --inbox-id 2>/dev/null || convos identity 2>/dev/null); then
  fallback "convos identity unavailable."
fi
SELF=$(printf '%s' "$SELF" | grep -oE '[0-9a-f]{64}' | head -n 1)
[ -n "$SELF" ] || fallback "could not read this install's inbox id."

if [ ! -f /data/convos/convo.id ]; then
  log "creating group conversation with agent inbox $INBOX..."
  CREATE_OUT=$(convos conversations create "$SELF/$INBOX" 2>&1) || fallback "create failed: $CREATE_OUT"
  CONVO=$(printf '%s' "$CREATE_OUT" | grep -oE "conversation[^']*'[^']*'" | head -n 1 | sed "s/.*'//;s/'//")
  [ -z "$CONVO" ] && CONVO=$(printf '%s' "$CREATE_OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f-]{27,}' | head -n 1)
  [ -z "$CONVO" ] && fallback "could not parse conversation id from: $CREATE_OUT"
  printf '%s' "$CONVO" > /data/convos/convo.id
  log "conversation $CONVO"
  convos conversation add-members --conversation-id "$CONVO" --inbox-ids "$INBOX" --as-admin >/dev/null 2>&1 \
    || log "add-members warning (continuing)"
else
  CONVO=$(cat /data/convos/convo.id)
  log "reusing conversation $CONVO"
fi

INVITE_OUT=$(convos conversation invite --conversation-id "$CONVO" 2>/tmp/invite.err; echo "rc=$?") || true
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
