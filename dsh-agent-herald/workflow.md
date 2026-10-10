# Herald — workflow

The release pipeline, stage by stage: source → ingest →
analyze → seal → upload → sync → cleanup — with each stage
mapped to the tool that performs it here.

`process.md` §1 is the checklist; this is the stage manual it
points at. Stage order is fixed. A stage that errors or times
out may have committed: read back before resubmitting
(`process.md` §4), and never report a stage complete without
its evidence artifact.

## 0. Source — find the bytes

Local files and acquisition imports both arrive the same
way: `prowlarr_search` (after
`prowlarr_indexers`), then `acquire_submit` with the hit's
`downloadUrl`/`magnetUrl`, then `acquire_status` to completion.
A local file handed to you directly starts at stage 1.
Resubmitting the same source resolves to its existing handle —
never force a duplicate. Evidence: the acquired file path.

## 1. Ingest — validate and dedup

Confirm size, type, and provenance (title, creator, source URL)
before anything billable happens. Then Tier-1 dedup against
the catalog: the catalog is the chain, so query it —
`arkiv_query` by `sha256_ct` of the plaintext.
A hit means this file already released: stop the pipeline and
say where it lives (CID, Arkiv key) instead of re-releasing it.
Near-duplicates (same content, different bytes) have no
automated check here — judge by metadata and say what you
decided. Evidence: sha256, dedup verdict.

## 2. Analyze — describe the plaintext BEFORE sealing

Order matters: analysis runs on plaintext, and sealing
destroys readability, so this stage always precedes stage 3.
There is no VLM tool — you are the analyzer. Write the
release notes a buyer deserves: what it is, timestamps or
sections that matter, content tags, anything mispriced or
mislabeled at the source. These notes ride along as Arkiv
attributes at stage 5, and the teaser portion may publish
free (clear `fcid`, `process.md` §2). Evidence: the notes.

## 3. Seal — `aol_seal`, nothing else (gated releases only — free releases skip this stage: no seal, no gate, no canister call)

Gate choice is `process.md` §2 — version, pattern, token,
threshold (always > 0), epoch or rungs, written down before this stage
starts. Then seal with `aol_seal`: plaintext path in, sealed
bytes plus `gateMetadataJson` out. v3 seals share one key per
community epoch (every file in the epoch carries the same
wrapped blob, kept across restarts in the key store — a
fresh boot reuses the epoch key rather than forking a new
blob); v1/v4 mint per seal — and every seal's bytes
are unique regardless, so sealing twice never reproduces a
release. Seal once per release, deliberately. Verify the
binding immediately
with `aol_gate_info`: version, token, threshold, and CID must
match what §2 decided. Evidence: sealed path, metadata JSON.

## 4. Upload — pin the release bytes

`synapse_pin` by path (sealed bytes when gated, plaintext when
free; by CID only for re-pins), then
`synapse_pin_status` until the pin is confirmed. The returned
CID is the release's permanent address — record it exactly;
every downstream record points at it. A pin that errors may
still have landed: status-check before re-pinning.
Evidence: the CID.

## 5. Sync — catalog on Arkiv

Distinguish create from update by lookup: `arkiv_query`
first, then `arkiv_create_entity` for a
new release or `arkiv_update_entity` for a revision — or one
`arkiv_create_entities` batch when the release is several
records (a drip series plus its parts lands in a single
transaction, never half-published). Batch only what is ready
in this session: urgency decides whether to wait for
stragglers, not whether to batch. A record that is ready now
with more still in flight ships immediately when it is
urgent ("drop it now", time-bound, a rung about to hit) and
waits for the session's natural batch point when it is
routine. Never hold a release past the conversation for a
fuller batch — no timer exists to flush it, and a held v3
record's epoch goes stale while it waits. Payload
carries `fcid`/`piece` (the stage-4 CID, exactly one —
`piece` + `gate` when gated, `fcid` with no `gate` key when
free), `gate` (the stage-3 metadata JSON, gated only), and
the stage-2 notes; attributes carry `grp`, `title`, the gate
corpus when gated (`gate_token`/`gate_chain`/`gate_threshold`,
numeric `gate_type` of 1, 3, or 4), `sha256_ct`, and `mime` —
the tool rejects anything outside the Haven record shape,
so a rejected write means fix the record, not the tool.
Query the entity back before announcing — the catalog entry
is what buyers will actually read. Evidence: the Arkiv key.

## 6. Cleanup — keep the evidence

Delete nothing. Originals, sealed bytes, and metadata stay
until the release is verified end to end (pin status green,
entity queried back, trial open passed) — and the gate
metadata JSON (gated releases) stays permanently, because
re-announcing or debugging a release without it means
re-deriving the gate from scratch.
Disk is cheap; unreproducible releases are not.

## The access path (answering "where is my file")

Consumption mirrors release in reverse, all reads until the
final open: locate via `arkiv_query` (attributes) and
`synapse_pin_status` (liveness), fetch the bytes (sealed when
gated, plaintext when free). Gated bytes go through inspect
with `aol_gate_info`, then `aol_decrypt` to a scratch path;
free bytes are byte-compared, never decrypted. Verify the
byte count either way. No download manager, no job
queue — the daemon-job concept has no harness equivalent and
needs none: each access is one conversation, fully evidenced.

## Deliberately absent

- Daemon job queues: none. Long work is a conversation
  with evidenced stages, not a background job id.
- `attestHolding`: no wrapper exists in any SDK. Do not
  promise on-chain holding proofs.
