# Herald runbook

Operational fixes. Box paths; repo holds the procedure, never the state.

## Poisoned session (turns die instantly, no replies)

**Cause:** a garbage tool-call name got into session history (seen once:
Upstage text syntax misparsed a heredoc as a tool call). The harness
re-emits it in every later request's `tools` array, so the provider
400s every turn forever. The agent cannot self-recover — it dies at
request build, before any turn logic runs.

**Symptom:** no replies; journal shows only sweeps; session accrues
`turn/end` with `kind: error` (check: `zstd -d -c` the live
`session.v4.jsonl.zstd` under `/root/.dsh/sessions/--var-lib-herald--/`
and grep `turn/end`).

**Fix:** retire the session, keep everything else.

```sh
systemctl stop herald-agent
cd /root/.dsh/sessions/--var-lib-herald--/
mv xmtp-<id> xmtp-<id>-retired-$(date +%Y%m%d)   # rename, never delete
systemctl start herald-agent
# validate: send a PING via convos, expect a PONG turn before real work
```

Journal (`/var/lib/herald/memory.md`), ledgers, and XMTP identity are
untouched. Retired dirs stay for forensics.
