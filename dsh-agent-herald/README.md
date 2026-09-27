# dsh-agent-herald

Herald, the sovereign release agent: a publisher that earns its keep
releasing files whose decryption is earned through ownership — hold a
DataDAO community's token and its corpus opens for you.

## The definition

| File | Prompt section | Order | Contents |
|---|---|---|---|
| `soul.md` | `agent:soul` | -500 | Who Herald is: goal, community covenant, money ethics, custody |
| `process.md` | `agent:process` | -400 | What Herald does: release pipeline, gate selection, money loop, community ops |
| `workflow.md` | `agent:workflow` | -350 | Stage manual: source→ingest→analyze→seal→upload→sync→cleanup, all harness-native |
| `reference/aol-protocol.md` | `agent:aol-protocol` | -300 | Haven-AOL v1/v3/v4 mechanics: derivation, epochs, market-cap math, errors |

`apply()` reads the four docs and registers each as a system-prompt
section (the tool-bash pattern). Sections render before the deployment
persona prefix (identity first, then deployment instructions, then
first-party guidance). No config — the docs are the config. A missing
or empty doc throws at apply: an agent never boots without its soul.

Token cost is fixed per deployment (the docs are static, prefix-stable
for KV cache); edits to any doc change every subsequent prompt.

## Money loop

Release tokens launched with the agent as fee recipient earn
mint/burn royalties; venue fees accumulate in routers and sweep on
cadence; v4 drips tie unlocks to market cap so community buying
drives both unlocks and royalties. `process.md` §3 is the procedure.

## Sealing is harness-native

`aol_seal` (v1/v3/v4) seals in-container under the canister-fetched
verification key — no operator side, no CLI. Herald seals its own
releases, verifies the binding (`aol_gate_info`), and trial-decrypts
before announcing. No procedure in this package shells out to a
`haven` CLI; none is installed.

## Note: the dead `persona` key (2026-09)

`dsh-persona/cordis.patch.yml` and `docker/profile.patch.yml` set
`system-prompt.config.persona`, which the installed
`dsh-system-prompt@0.1.7-rc.2` never reads — its schema declares
`personaPrefix`/`personaSuffix` (`Config({persona: ...})` parses but
the constructor ignores the key). Until this package, the deployment
ran with an empty persona. Herald's sections are the live identity
now; those `persona` rows are inert documentation. If they are ever
migrated to `personaPrefix`, that text will render *after* these
sections (order 0) — keep it short or fold it here.
