# dsh-treasury

Economic survival engine for DeepSeek Harness — haven-core's `Treasury`
machine re-homed onto dsh seams. The agent exists only as long as it can pay
for resources; this package tracks that, and stops the loop when it no longer
can.

Concept transfer (haven-core → dsh):

| haven-core | here |
|---|---|
| Treasury machine state (`Funded ↔ Low ↔ Critical ↔ Depleted`) | *derived* state: recomputed from ledger rows after every durable write, never stored, so it cannot drift |
| balances / expense ledger in machine memory | schema-validated storage-domain records (`treasury` domain, `balances` + `expenses` tables) |
| `eCostAuthorize` request/response | `ctx.treasury.authorize(category, µUSD)` — the same per-state matrix as a pure function |
| InferencePipeline middleware | `agent/request` waterfall middleware (throw = request fails, no recovery) |
| ToolExecutor cost gate | `tools/pre-execute` waterfall (`{ kind: 'deny' }` short-circuit, enforced in the executor) |
| token accounting | `ctx.tokenMeter.measure(session)` — request pressure × configured price |

All USD figures are integers in µUSD (USD × 1e6), haven-core's precision.

## Install

```sh
dsh plugin --profile <name> add /path/to/dsh-treasury
```

Two rows activate: `treasury` (the ledger, `ctx.treasury`) and
`treasury-policy` (enforcement). The ledger needs the non-session storage
stack (`storage`, `storage-json`, `storage-domain` rows) — the `dsh-web-app`
bundle mounts it already; on other profiles add the three rows to your
profile's `cordis.patch.yml` (see this package's `cordis.patch.yml` for the
exact snippet). Set `inferenceUsdPerMillionTokens` to your model's price.

## The ledger (`ctx.treasury`)

- `updateBalances(balances)` — replace the balance sheet (haven
  `eBalanceUpdate`); rows are `{ chain, token, amount, usdEstimate }`.
- `recordExpense({ category, amount, token?, description? })` — append to the
  ledger (haven `eExpenseRecord`); retention-bounded by `maxExpenses`.
- `report()` — haven `TreasuryReport`: state, balances, `totalValueUsd`,
  `dailyBurnUsd`, `runwayDays`, budget, recent expenses.
- `state()` — `funded | low | critical | depleted`, from
  `computeTreasuryState(computeRunway(totalValue, dailyBurn))`: > 30 days
  funded, > 7 low, > 0 critical, else depleted.
- `authorize(category, estimatedCostUsd)` — the per-state matrix: funded =
  budget check; low = reserve locked; critical = infrastructure/storage always
  approved, inference only under $0.10, rest denied; depleted = all denied.

Daily burn = `fixedDailyBurnUsd` + expenses in the trailing `burnWindowMs`
scaled to a day. Budget defaults to haven's allocation (inference 38, tools
14, infrastructure 28, storage 5, messaging 10, reserve 5; must total 100).

Events (both emitted strictly after the durable write — the commit point):
`treasury/state-changed` `{ previous, current, report }` and
`treasury/expense`.

## The policy (`dsh-treasury/policy`)

- **`agent/request`** — prices the pending request
  (`tokenMeter.measure(session).totalTokens × inferenceUsdPerMillionTokens`),
  asks `authorize('inference', cost)`, and **throws `TreasuryDeniedError`
  without calling `next()`** on denial: a request-middleware throw fails the
  request with no recovery offered. Approved requests record the estimated
  spend before dispatch (fail-closed: a ledger write failure fails the
  request — a survival engine never runs unmetered).
- **`tools/pre-execute`** — resolves a call's declared cost (`toolCosts`
  patterns, else `defaultToolCostUsd`) and category (`toolCategories`
  patterns, else `tools`), asks the matrix, and **returns
  `{ kind: 'deny', reason }` without `next()`** on denial — the registry
  materializes the error result, so denial holds for every caller that
  reaches the executor. Zero-cost calls pass ungated: a free read is not a
  spend, and the inference gate owns survival halting.
- **`tools/post-execute`** — records an admitted call's declared cost when
  the call settles (observe-and-record; always delegates).

Enforcement activates once the treasury is funded (any balance row). A
never-funded ledger meters but denies nothing — haven's zero-value rule
("empty treasury = 100% spent") would otherwise brick a fresh install.

## Extension points

- `treasury/state-changed` for degraded-mode UX (e.g. prompt sections,
  notifications) and `treasury/expense` for audit sinks.
- Balance feeds: schedule `ctx.treasury.updateBalances(...)` from `schedule/`
  or `jobs/` with your chain data source; this package deliberately fetches
  nothing on-chain.
- The pure matrix (`authorizeCost`, `computeRunway`, `computeTreasuryState`)
  is exported for bespoke policies.

## Model Experience

No tools and no prompt sections ship here. The model experiences the
treasury only through enforcement: a denied tool call surfaces as that call's
error result (`Error: treasury denied <tool>: …` — a normal tool error the
model can read and react to), and a denied request ends the turn with an
error. Token cost: zero added request content; the deny text replaces a
result that would have existed anyway. KV-cache: no request-prefix impact.

## Known Limitations and Deferred Work

- Inference metering prices *request pressure* (the token-meter's measure of
  what the next call carries) rather than provider-billed usage; it
  over-approximates output-heavy turns and is documented as an estimate.
- Tool costs are config-declared estimates recorded at settlement, whether
  the call succeeded or failed; a call admitted by this policy but denied by
  a later pre-execute listener still records its declared cost.
- No model-visible treasury report tool or prompt section yet; state changes
  are observable by plugins, not the model, until a consumer justifies one.
- Category spend percentages compare lifetime retained expenses against
  *current* treasury value (haven-core's exact rule); long-lived agents that
  re-fund repeatedly may want a windowed variant.
