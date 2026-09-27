# dsh-exactly-once

Transparent exactly-once guard for DeepSeek Harness write tools. A
`tools/execute` wrapper (the timeout-policy shape) that needs no model
cooperation and adds no tools or parameters:

- **Redelivery dedup by call identity.** One model call block carries one
  `callId`, so a redelivered call shares `(agent, rootCallId, callId)` and
  a model retry does not. Repeats of an in-flight call attach to it;
  repeats of a settled call replay the recorded result. The body runs
  once.
- **Session-ledger repeat evidence.** Canonical values are deliberately
  omitted from durable events and the harness never re-dispatches a
  settled callId after restart (repair closes dangling calls with
  synthetic errors), so the cold path folds `tool/call` + `tool/result`
  pairs into last-outcome evidence instead of replaying successes.
- **Repeat-after-ambiguous checks.** An exact repeat (same agent, tool,
  canonical arguments) following a non-success consults that tool's
  read-back hook when one is registered through
  `ctx.exactlyOnce.registerCheck`; without a hook the call dispatches
  and the attempt is recorded. Ambiguous errors (timeout, abort,
  unclassified throws) carry an attempt trailer; classified failures
  (`INVALID_ARGS`, treasury denials) pass through byte-identical.

Reads and unlisted tools pass through with zero tracking.

## Install

```sh
dsh plugin --profile <name> add /path/to/dsh-exactly-once
```

`inject = ['tools']` only. The `agent/pre-step` repeat reset rides the
context event without a service dependency.

## Config

```yaml
- id: exactly-once
  name: 'dsh-exactly-once'
  config:
    writes: ['synapse_pin', '*_submit', 'erc8004_register']  # *-wildcards; default covers the stack writes
    exempt: []  # exempt wins over writes
```

## Tests

```sh
pnpm vitest run dsh-exactly-once/tests/guard.spec.ts
```

Redelivery, replay, transparency, and hook verdicts run through the real
executor; cold-session paths run the wrapper directly against fabricated
session events.

## Known Limitations and Deferred Work

- Repeat-after-ambiguous without a registered hook re-dispatches. The
  stack's write surfaces register hooks (`erc8004_register`,
  `rr_launch`/`rr_sweep`/`rr_heartbeat`, `<prefix>_submit`,
  `synapse_pin`, `arkiv_create_entity`/`arkiv_update_entity`); XMTP
  answers through its reply outbox instead (a channel, not a tool).
- Cross-conversation retries of one intent need explicit keys (out of
  scope); treasury re-meters replayed successes as estimate noise.
