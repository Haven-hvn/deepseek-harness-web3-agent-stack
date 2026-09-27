#!/bin/sh
# convos-qr.sh — idempotent Convos invite + QR for Herald (native install).
# Waits for the agent's XMTP db, then mints (or reuses) a group conversation
# with the agent's inbox and prints the invite URL + QR. Never fails boot:
# diagnostics + DM fallback on any error, exit 0 always.
set -eu

STATE=/var/lib/herald
CONVOS_HOME="$STATE/convos"
export CONVOS_HOME

log() { echo "convos-qr: $*"; }
fallback() {
  log "$1"
  log "DM fallback: message the agent EVM address from any XMTP client:"
  log "  $(cat $STATE/keys/evm.address 2>/dev/null || echo '<keys missing>')"
  exit 0
}

for _ in $(seq 1 90); do
  [ -f $STATE/xmtp/agent.db ] && break
  sleep 10
done
[ -f $STATE/xmtp/agent.db ] || fallback "agent XMTP db never appeared; is herald-agent up?"
sleep 10

mkdir -p "$CONVOS_HOME"
INBOX=$(cat $STATE/keys/inbox.id)

if [ ! -f "$CONVOS_HOME/convo.id" ]; then
  log "creating group conversation with agent inbox $INBOX..."
  CREATE_OUT=$(convos conversations create --name "herald-$(date +%s)" --env production --json 2>&1) \
    || fallback "create failed: $CREATE_OUT"
  # Strip non-JSON log lines (sqlcipher warnings) before parsing.
  CREATE_JSON=$(printf '%s' "$CREATE_OUT" | sed -n '/^{/,$p')
  CONVO=$(printf '%s' "$CREATE_JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(j.conversationId||j.id||j.conversation?.id||'')}catch{}})") \
    || true
  [ -z "$CONVO" ] && CONVO=$(printf '%s' "$CREATE_OUT" | grep -oE '"conversationId": *"[^"]+"' | head -n 1 | sed 's/.*": *"//;s/"//')
  [ -z "$CONVO" ] && CONVO=$(printf '%s' "$CREATE_OUT" | grep -oE '[0-9a-f]{32}' | head -n 1)
  [ -z "$CONVO" ] && fallback "could not parse conversation id from: $CREATE_OUT"
  printf '%s' "$CONVO" > "$CONVOS_HOME/convo.id"
  log "conversation $CONVO"
  convos conversation add-members "$CONVO" "$INBOX" --env production >/dev/null 2>&1 \
    || log "add-members warning (continuing)"
else
  CONVO=$(cat "$CONVOS_HOME/convo.id")
  log "reusing conversation $CONVO"
fi

INVITE_OUT=$(convos conversation invite "$CONVO" --env production 2>/tmp/herald-invite.err; echo "rc=$?") || true
URL=$(printf '%s' "$INVITE_OUT" | grep -oE 'https://[^ ]*' | head -n 1)
[ -z "$URL" ] && fallback "invite minting failed: $(head -c 300 /tmp/herald-invite.err)"
echo ""
echo "Convos invite: $URL"
echo ""
if command -v qrencode >/dev/null 2>&1; then
  qrencode -t ANSIUTF8 -m 2 "$URL"
else
  log "qrencode not installed; scan the URL above in the Convos app"
fi
echo ""
exit 0
