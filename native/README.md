# Herald native install (no Docker)

Systemd-native deployment of the Herald sovereign release agent on this box.
Source of truth for everything except secrets (which live only on the box).

## Layout

| Path | What |
| --- | --- |
| `/root/.dsh/profiles/herald/` | dsh profile (16 stack bundles + `@xmtp/node-sdk`) |
| `/root/.dsh/profiles/herald/cordis.patch.yml` | user layer — copy of `herald.patch.yml` |
| `/root/.dsh/.credentials.yaml` (0600) | `AGENT_EVM_KEY`, `XMTP_DB_KEY` |
| `/etc/herald/agent.env` (0600) | `MODEL_BASE_URL`, `MODEL_ID`, `MODEL_API_KEY`, `PROWLARR_API_KEY` |
| `/var/lib/herald/` | state: `xmtp/`, `downloads/`, `convos/`, `observatory/`, `prowlarr/`, `transmission/`, `qbithome/`, `keys/` (public address + inbox id) |
| `/var/lib/herald/memory.md` (0600) | Herald's private journal — single markdown file, opt-in only, never injected (see §7 of `process.md`) |
| `/opt/herald/` | `convos-qr.sh`, `setup-indexers.mjs`, `round.sh`, `round-prompt.md` |
| `/etc/systemd/system/herald-*` | units — copies of `systemd/` |

## Services

`herald-agent` (dsh profile herald), `herald-dashboard` (:8787),
`herald-prowlarr` (:9696), `herald-qbittorrent` (:8080),
`herald-transmission` (:9091), one-shots `herald-setup-indexers` and
`herald-convos-qr`, long-runners `herald-convos-watch` (auto-approves Convos
join requests) and `herald-round.timer` (autonomous round every 6h).

The round timer sends `round-prompt.md` into the group chat from the
box-side Convos identity; Herald answers it as a normal turn with full
tool access, so every round is observable in Convos.

## Chain posture

Testnets: Sepolia, Base Sepolia, Filecoin calibration (FEVM testnet),
Arkiv Tiramisu. XMTP is production (messaging, not money). Royalty router
rides Base mainnet config for quotes (no factory deployed — advise only).

## Reinstall / update

```sh
# after pulling stack changes:
# The CLI must match the stack's @deepseek-ai/dsh-* peers exactly: dsh
# denies a bundle whose peers don't satisfy the running version.
npm i -g @deepseek-ai/dsh@0.2.1-alpha.1
pnpm install --frozen-lockfile && pnpm -r build
# After a dsh version change, re-resolve the profile install so it carries no
# packages from the previous version (same set as the Dockerfile; STACK is
# this checkout). Idempotent; profile sessions and cordis.patch.yml are kept.
STACK=$PWD
dsh plugin --profile herald add \
  "$STACK/dsh-exactly-once" "$STACK/dsh-wallet" "$STACK/dsh-wallet-ethereum" \
  "$STACK/dsh-wallet-tools" "$STACK/dsh-treasury" "$STACK/dsh-channel-xmtp" \
  "$STACK/dsh-storage-synapse" "$STACK/dsh-arkiv" "$STACK/dsh-erc8004" \
  "$STACK/dsh-royalty-router" "$STACK/dsh-haven-aol" "$STACK/dsh-persona" \
  "$STACK/dsh-tool-prowlarr" "$STACK/dsh-tool-acquisition" \
  "$STACK/dsh-observatory" "$STACK/dsh-agent-herald"
dsh plugin --profile herald add @xmtp/node-sdk
pip3 install 'mutagen==1.48.1' # ID3 chapters for merged MP3s (process.md §1 step 2)
cp native/herald.patch.yml /root/.dsh/profiles/herald/cordis.patch.yml
cp native/*.sh native/*.mjs native/*.md /opt/herald/
cp native/systemd/* /etc/systemd/system/ && systemctl daemon-reload
set -a; . /etc/herald/agent.env; set +a
dsh --profile herald --dump-config > /dev/null && systemctl restart herald-agent
```

Secrets are never in this repo: to re-create them see the journal
(`journalctl -u herald-agent`) — the agent prints its address, never keys.

The XMTP outbox (`/var/lib/herald/xmtp/outbox.json`) upgrades in place:
version-1 files load and gain per-conversation outbound cursors on first
write. Restarting `herald-agent` no longer loses or repeats replies: output
committed before the restart is sent on reconnect, output already sent is
sends to drain (`systemd/herald-agent.service` sets `TimeoutStopSec=30`).

## Chat behavior

One conversation runs one agent turn at a time. A message that arrives
mid-turn gets a one-line "still working" ack and its own turn afterwards
(`busyAck` / `busyInbound` in `herald.patch.yml`). Long jobs go to the
background (`process.md` §10) and their results arrive as unprompted
messages; `tool-jobs.maxConsecutiveWakes: 3` bounds self-waking chains.

## Gotchas (learned live)

- Upstage rejects the harness `store` param → model `compat:
  {supportsStore: false, supportsReasoningEffort: false}` in the patch.
- The Upstage key is rate-limited → spark route carries an extended
  `retryPolicy` (8 retries, 60s max backoff). Sustained interactive bursts
  can still 429; the turn fails loud and the next message retries.
- Upstage tool calls use a text syntax the harness parses; multi-address
  args occasionally truncate model-side (both solar models). Simple calls
  (wallet, search, epoch, query) are solid; complex ones may need a retry.
- `dsh --profile herald --help` boots the profile (second XMTP client on
  the same identity) — don't run it while the service is up.
- qBittorrent needs `WebUI\AuthSubnetWhitelist{Enabled,=127.0.0.1/32}` or
  its API 403s for localhost clients (acquisition + observatory probe).
