# Haven-AOL protocol reference

What Herald knows about the access layer. Sourced from the haven-aol
repository (README, `src/backend/backend.did`, TS/Python SDKs) and the
`dsh-haven-aol` bridge. The canister is the authority; this file is
your memory of it.

## The shape of the system

Haven-AOL ("Always Online") is an ICP canister (`gny6k-fqaaa-aaaab-ag3ra-cai`,
host `https://icp-api.io`) that hands out decryption keys **only when
on-chain policy is satisfied**. Flow per decrypt: the holder signs an
EIP-712 gate request with their EVM wallet → the canister verifies the
signature, checks the token balance (and, for v4, the market cap) →
returns a VetKD-derived key ciphertext → the client unwraps locally
and AES-decrypts. Keys never leave the decrypting call. Uploaders
choose the protocol per file via the `version` field in gate
metadata; on Arkiv the same number rides as the `gate_type` attribute
(`1`/`3`/`4`, numeric).

## v1 — per-CID derivation

- One VetKD key per content ID. N files = N balance-checks + N
  derivations. Best for individual premium files.
- Preimage: `SHA-256("accessol:" + chain + ":" + tokenAddress +
  ":" + threshold + ":" + cid)`. VetKD context: `accessol_v1`.
- EIP-712 type: `GateRequest(address evmAddress, bytes
  transportPublicKey, uint256 nonce)` (no epoch — v1 is epochless).

## v3 — corpus + epoch derivation

- One VetKD key opens **every CID** a community seals in a 30-day
  epoch. One balance-check gates a whole corpus. The DataDAO mode.
- Epoch: 2,592,000 seconds; `currentEpoch = floor(unix / 2592000)`.
- Preimage: `SHA-256("accessol_v3:" + chain + ":" + tokenAddress +
  ":" + threshold + ":" + effectiveEpoch)`. Context: `accessol_v3`
  (distinct master key from v1).
- **Threshold-zero collapse:** `threshold == 0` forces
  `effectiveEpoch = 0` — free-tier content shares one eternal key
  across all epochs. Uploader metadata must say epoch 0 to match.
- **Approval cache:** balance results cache per `(chain, token,
  threshold, epoch, wallet)` for 30 days; hot-path decrypts skip
  the EVM `eth_call`. Entries die on epoch rotation or TTL.
- EIP-750-style request carries the epoch; the canister rejects
  future epochs authoritatively (`aol_epoch` is advisory only).
- Gate order: future-epoch rejection → EIP-712 verify → holder
  gate (cached) → VetKD derive.

## v4 — market-cap-gated drip derivation

- A release split into chunks; chunk `i` unlocks when the gate
  token's bonding-curve market cap reaches its rung `T_i` in
  **whole reserve units** (whole ETH for native-reserve tokens).
  Only mint.club V2 bonding-curve tokens can gate — by
  construction, not allowlist.
- Preimage adds the rung: `SHA-256("accessol_v4:" + chain + ":" +
  tokenAddress + ":" + threshold + ":" + effectiveEpoch + ":" +
  marketCapTarget)`. Context: `accessol_v4` (third master key).
- **Oracle:** the chain's mint.club V2 **Bond contract is the only
  price source** — no Chainlink leg. `oracleAddress` must name the
  chain Bond contract or the call fails closed **before touching
  the chain** (`#InvalidOracle`).
- **Cap math:** `supplyRaw × priceNextMintWei / 10^tokenDecimals >=
  marketCapTarget × 10^reserveDecimals`. Cap = supply × **marginal
  (next-mint) price** — the bonding-curve convention, not a
  DEX-clearing valuation.
- **Curve ceiling:** `maxSupply × finalPrice` is the hard max.
  Rungs above it can never unlock. The curve is immutable after
  launch; raising the ceiling means launching a new token.
- **Burst cache:** cap snapshots cache per `(chain, token)` for
  **300 seconds only** — markets reprice; a failed refresh never
  extends a stale snapshot. ERC20 `decimals()` caches permanently
  (immutable). Zero-price or failed curve reads fail closed.
- **EIP-712 type (v4):** `GateRequestV4(address evmAddress, bytes
  transportPublicKey, uint256 epoch, uint256 marketCapTarget,
  uint256 nonce)`. The signature commits to the requested target —
  a reader cannot sign low and claim high. `oracleAddress` is
  validated but NOT a signed field.
- Gate order: future-epoch rejection → EIP-712 verify → holder
  gate (shared v3 approval cache) → market-cap gate → derive.

## Errors (report verbatim, then translate)

- `InsufficientBalance` — holder is short; name the shortfall.
- `MarketCapNotReached {required, actual}` — whole reserve units;
  name both numbers and what moves the cap (mints).
- `InvalidSignature` — the EIP-712 digest signature failed. Note:
  `ctx.wallet.signMessage` is EIP-191 (personal prefix) and is
  ALWAYS rejected here; the canister wants a raw EIP-712 digest
  signature (`signDigest`, raw-key provider). One retry, then stop.
- `InvalidEpoch` — request epoch is in the future (or mismatched).
- `InvalidOracle` — non-Bond oracle, unsupported non-native
  reserve, or failed curve read. Config fault, not holder fault.

## Methods and tools

- Canister updates: `requestDecryptionKey[V3][V4]` (gate proof →
  checks → key ciphertext), `getMarketCap` (diagnostic, whole
  reserve units), `warmupVetKDPublicKeyV4`; queries:
  `getVetKDPublicKey[V4]`, `getBondConfig`; controller-only:
  `setBondConfig`, `evictExpiredMarketCaps`. Deliberately absent
  everywhere: `attestHolding` (no wrapper in any SDK).
- Your tools: `aol_gate_info` (pure metadata parse + v4 Bond-pin
  pre-check — call before every decrypt), `aol_epoch`,
  `aol_market_cap` (whole reserve units, 300s burst cache,
  client-side Bond rejection), `aol_decrypt` (v1/v3/v4
  auto-dispatch; path or CID in, plaintext file out).
- Encrypt-side is `aol_seal` (v1/v3/v4, harness-native): fresh
  AES-GCM key per seal, IBE-wrapped under the canister-fetched
  verification key, gate metadata out. Seal once per release —
  a second seal mints a different key and a different release.
