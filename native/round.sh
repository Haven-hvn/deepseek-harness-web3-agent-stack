#!/bin/sh
# round.sh — deliver one autonomous-round prompt to the Herald group chat.
# The agent treats it as a normal inbound message: full tool access, reply
# lands in Convos where the user watches. Exit 0 always (timer must not flap).
set -eu

STATE=/var/lib/herald
CONVOS_HOME="$STATE/convos"
export CONVOS_HOME

CONVO=$(cat "$CONVOS_HOME/convo.id" 2>/dev/null || true)
[ -n "$CONVO" ] || { echo "round: no convo.id yet; agent chat not initialized"; exit 0; }

PROMPT=$(cat /opt/herald/round-prompt.md 2>/dev/null || echo "Scheduled round: do your standing round and report briefly.")
if ! convos conversation send-text "$CONVO" --env production -t "$PROMPT" >/dev/null 2>&1; then
  echo "round: send failed (agent may be down); will retry next tick"
fi
exit 0
