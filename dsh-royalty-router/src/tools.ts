/**
 * Tool logic for dsh-royalty-router.
 *
 * Pure functions over `@royalty-router/sdk`, kept separate from the Cordis
 * wiring in `index.ts` so they are unit-testable without a harness:
 * - `adviseIntentTool` — offline intent fill + model warnings (no RPC).
 * - `venueTool` — live curve-vs-pool quote + crossover size (RPC reads).
 * - `buildTool` — launch dry-run; requires a factory address (until the
 *   live factory is deployed, point at a local fork deployment).
 * - `launchTool` — approve → simulate → send a launch (needs a signer).
 * - `sweepTool` — sweep a router's pending royalties into locked liquidity.
 * - `heartbeatTool` — stamp router activity when no sweep is due.
 *
 * Bigints cross the tool boundary as decimal strings (the `rr` CLI
 * convention); `jsonSafe` enforces that recursively.
 *
 * @module dsh-royalty-router/tools
 */

import { createHash } from "node:crypto";
import type { PublicClient, WalletClient } from "viem";
import {
  adviseIntent,
  bandBps,
  bondAbi,
  buildLaunch,
  crossoverSize,
  heartbeat,
  launch,
  poolIdOf,
  poolKeyFor,
  predictTokenAddress,
  quoteVenues,
  readVenueState,
  recommendedIntent,
  routerStatus,
  sweep,
  ZERO,
  type Deployment,
  type LaunchIntent,
} from "@royalty-router/sdk";
import { erc20Abi } from "viem";

export interface ChainDeps {
  client: PublicClient;
  deployment: Deployment;
}

/** Reads plus a signer: what the execute tools (`rr_launch` / `rr_sweep` /
 * `rr_heartbeat`) need. `index.ts` builds the wallet client over
 * `ctx.wallet`; tests pass a real or stub client directly. */
export interface ExecuteDeps extends ChainDeps {
  wallet: WalletClient;
}

/** 0x-prefixed 20-byte address, or an actionable error (never echoes input). */
export function assertAddress(value: unknown, field: string): `0x${string}` {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(
      `dsh-royalty-router: ${field} must be a 0x-prefixed 20-byte address`,
    );
  }
  return value as `0x${string}`;
}

/** Decimal-string bigint, or an actionable error. Safe-integer numbers are
 * accepted too (small values survive JSON losslessly); larger magnitudes
 * must arrive quoted. */
export function big(value: unknown, field: string): bigint {
  try {
    if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
    if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  } catch { /* fall through to the error below */ }
  throw new Error(`dsh-royalty-router: ${field} must be a decimal-string integer`);
}

/** Plain number for bps/fee/spacing fields; decimal-string integers are
 * accepted too (models burned by the lossless-JSON rule send everything
 * quoted — rejecting those would trap callers both ways). */
export function num(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    if (Number.isSafeInteger(n)) return n;
  }
  throw new Error(`dsh-royalty-router: ${field} must be a number or decimal-string integer`);
}

/** Recursively render bigints as decimal strings (Infinity-safe) for tool output.
 * Mirrors JSON semantics for the rest: `undefined` (and functions/symbols)
 * are dropped from objects and nulled in arrays — the harness lossless
 * validator rejects `undefined` anywhere, while `JSON.stringify` would
 * silently drop it, hiding the mismatch until boot. */
export function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && !Number.isFinite(value)) {
    return value > 0 ? "infinity" : "-infinity";
  }
  if (Array.isArray(value)) return value.map((v) => jsonSafe(v) ?? null);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined && typeof v !== "function" && typeof v !== "symbol")
        .map(([k, v]) => [k, jsonSafe(v)]),
    );
  }
  return value;
}

export interface CurveSpec {
  freeRange: string;
  maxSupply: string;
  startPrice: string;
  endPrice: string;
  steps?: number;
}

export interface IntentArgs {
  name: string;
  symbol: string;
  reserveToken: string;
  feeRecipient: string;
  /** Geometric curve (recommended path). Ignored when `steps` is given. */
  curve?: CurveSpec;
  /** Explicit steps (alternative to `curve`); requires mint/burn royalties. */
  steps?: { rangeTo: string; price: string }[];
  mintRoyaltyBps?: number;
  burnRoyaltyBps?: number;
  curveMint?: string;
  seed?: { tokens: string; secondary: string };
  secondary?: string;
  fee?: number;
  tickSpacing?: number;
  compoundShareWad?: string;
  bountyBps?: number;
  minClaim?: string;
}

/** Build a LaunchIntent from tool args: geometric-recommended or explicit. */
export function buildIntent(args: IntentArgs): LaunchIntent {
  const reserveToken = assertAddress(args.reserveToken, "reserveToken");
  const feeRecipient = assertAddress(args.feeRecipient, "feeRecipient");
  const curveMint = args.curveMint === undefined ? 0n : big(args.curveMint, "curveMint");
  const seed = args.seed === undefined
    ? undefined
    : { tokens: big(args.seed.tokens, "seed.tokens"), secondary: big(args.seed.secondary, "seed.secondary") };
  const secondary = args.secondary === undefined ? undefined : assertAddress(args.secondary, "secondary");
  const minClaim = args.minClaim === undefined ? undefined : big(args.minClaim, "minClaim");
  const compoundShareWad = args.compoundShareWad === undefined ? undefined : big(args.compoundShareWad, "compoundShareWad");

  if (args.steps !== undefined) {
    // Explicit-curve path (e.g. sdk/example.intent.json).
    if (args.mintRoyaltyBps === undefined || args.burnRoyaltyBps === undefined) {
      throw new Error(
        "dsh-royalty-router: explicit steps require mintRoyaltyBps and burnRoyaltyBps",
      );
    }
    if (seed === undefined) {
      throw new Error("dsh-royalty-router: explicit steps require seed {tokens, secondary}");
    }
    return {
      name: args.name,
      symbol: args.symbol,
      reserveToken,
      feeRecipient,
      mintRoyaltyBps: num(args.mintRoyaltyBps, "mintRoyaltyBps"),
      burnRoyaltyBps: num(args.burnRoyaltyBps, "burnRoyaltyBps"),
      steps: args.steps.map(s => ({ rangeTo: big(s.rangeTo, "steps[].rangeTo"), price: big(s.price, "steps[].price") })),
      curveMint,
      seed,
      ...(secondary === undefined ? {} : { secondary }),
      ...(args.fee === undefined ? {} : { fee: num(args.fee, "fee") }),
      ...(args.tickSpacing === undefined ? {} : { tickSpacing: num(args.tickSpacing, "tickSpacing") }),
      ...(compoundShareWad === undefined ? {} : { compoundShareWad }),
      ...(args.bountyBps === undefined ? {} : { bountyBps: num(args.bountyBps, "bountyBps") }),
      ...(minClaim === undefined ? {} : { minClaim }),
    };
  }

  // Geometric-recommended path.
  if (args.curve === undefined) {
    throw new Error("dsh-royalty-router: provide either curve {freeRange, maxSupply, startPrice, endPrice} or explicit steps");
  }
  const intent = recommendedIntent({
    name: args.name,
    symbol: args.symbol,
    reserveToken,
    feeRecipient,
    curve: {
      freeRange: big(args.curve.freeRange, "curve.freeRange"),
      maxSupply: big(args.curve.maxSupply, "curve.maxSupply"),
      startPrice: big(args.curve.startPrice, "curve.startPrice"),
      endPrice: big(args.curve.endPrice, "curve.endPrice"),
      ...(args.curve.steps === undefined ? {} : { steps: num(args.curve.steps, "curve.steps") }),
    },
    ...(seed === undefined ? {} : { seed }),
    ...(args.curveMint === undefined ? {} : { curveMint }),
    ...(secondary === undefined ? {} : { secondary }),
    ...(minClaim === undefined ? {} : { minClaim }),
  });
  if (args.mintRoyaltyBps !== undefined) intent.mintRoyaltyBps = num(args.mintRoyaltyBps, "mintRoyaltyBps");
  if (args.burnRoyaltyBps !== undefined) intent.burnRoyaltyBps = num(args.burnRoyaltyBps, "burnRoyaltyBps");
  if (args.fee !== undefined) intent.fee = num(args.fee, "fee");
  if (args.tickSpacing !== undefined) intent.tickSpacing = num(args.tickSpacing, "tickSpacing");
  if (compoundShareWad !== undefined) intent.compoundShareWad = compoundShareWad;
  if (args.bountyBps !== undefined) intent.bountyBps = num(args.bountyBps, "bountyBps");
  return intent;
}

/** Offline: fill the recommended intent and report where it departs from the model. */
export async function adviseIntentTool(args: IntentArgs): Promise<unknown> {
  const intent = buildIntent(args);
  const advice = adviseIntent(intent);
  return jsonSafe({
    intent,
    advice,
    bandBps: bandBps(intent.mintRoyaltyBps, intent.burnRoyaltyBps),
  });
}

export interface VenueArgs {
  token: string;
  secondary?: string;
  fee?: number;
  tickSpacing?: number;
  side: "buy" | "sell";
  /** Exact trade size, decimal string (reserve wei for buy, token wei for sell). */
  amountIn: string;
}

/** Live: quote one trade on both venues plus the crossover size. */
export async function venueTool(deps: ChainDeps, args: VenueArgs): Promise<unknown> {
  if (args.side !== "buy" && args.side !== "sell") {
    throw new Error(`dsh-royalty-router: side must be "buy" or "sell"`);
  }
  const token = assertAddress(args.token, "token");
  const secondary = args.secondary === undefined ? ZERO : assertAddress(args.secondary, "secondary");
  const key = poolKeyFor(
    deps.deployment,
    token,
    secondary,
    args.fee ?? 3000,
    args.tickSpacing ?? 60,
  );
  const amountIn = big(args.amountIn, "amountIn");
  const state = await readVenueState(deps.client, deps.deployment, token, key);
  const quote = quoteVenues(state, args.side, amountIn);
  return jsonSafe({
    token,
    poolKey: key,
    poolId: poolIdOf(key),
    quote,
    crossoverSize: crossoverSize(state, args.side, amountIn),
  });
}

/** Dry-run: full launch struct, value, approvals, predicted addresses. Requires a factory address. */
export async function buildTool(deps: ChainDeps, args: IntentArgs): Promise<unknown> {
  if (!deps.deployment.factory) {
    throw new Error(
      "dsh-royalty-router: no factory configured for this chain — set 'factory' "
      + "in plugin config. Until the live factory is deployed, point at a "
      + "local fork deployment (see README).",
    );
  }
  const intent = buildIntent(args);
  const built = await buildLaunch(deps.client, deps.deployment, intent);
  return jsonSafe(built);
}

/** Send a launch: approve (if needed), simulate, send. Caller funds the
 * reserve/seed (fork: deal + approve first); nothing is signed locally —
 * the wallet client signs per operation through `ctx.wallet`. */
export async function launchTool(deps: ExecuteDeps, args: IntentArgs): Promise<unknown> {
  if (!deps.deployment.factory) {
    throw new Error(
      "dsh-royalty-router: no factory configured for this chain — set 'factory' "
      + "in plugin config. Until the live factory is deployed, point at a "
      + "local fork deployment (see README).",
    );
  }
  const intent = buildIntent(args);
  const built = await buildLaunch(deps.client, deps.deployment, intent);
  const res = await launch(deps.client, deps.wallet, deps.deployment, built);
  return jsonSafe(res);
}

export interface SweepArgs {
  /** Router to sweep (0x...). */
  router: string;
  /** Swap floor for swapper routes, decimal string (default "0" — fine on swap-free routes). */
  minOut?: string;
}

/** Sweep one router's pending royalties into locked liquidity. Simulates
 * first (a revert costs nothing); the keeper loop stays out — call when
 * `routerStatus` reports ready, or let Gelato/cron consume it. */
export async function sweepTool(deps: ExecuteDeps, args: SweepArgs): Promise<unknown> {
  const router = assertAddress(args.router, "router");
  const minOut = args.minOut === undefined ? 0n : big(args.minOut, "minOut");
  const res = await sweep(deps.client, deps.wallet, router, minOut);
  return jsonSafe(res);
}

export interface HeartbeatArgs {
  /** Router to stamp activity on (0x...). */
  router: string;
}

/** Permissionless activity stamp for a router with nothing worth sweeping.
 * Keeps a live token from looking stale; never moves funds. */
export async function heartbeatTool(deps: ExecuteDeps, args: HeartbeatArgs): Promise<unknown> {
  const router = assertAddress(args.router, "router");
  const receipt = await heartbeat(deps.client, deps.wallet, router);
  return jsonSafe({ transactionHash: receipt.transactionHash, status: receipt.status });
}

// ── Exactly-once: attempt ledger + commit-point read-back ────────────────
// The SDK's send path (launch/sweep/heartbeat) waits for receipts with no
// bound and exposes the tx hash only on success, so a timeout leaves no
// hash to look up. The ledger closes that hole without touching the SDK:
// runs attach to in-flight sends, late settles are recorded for the retry
// (the raced send is never cancelled — its wait keeps polling), and chain
// read-back (bond.exists + token name for launches, routerStatus for
// sweeps) covers restarts. The wallet lane (withWalletLane) serializes the
// approve → simulate → send sequences per wallet so concurrent executes
// never share a nonce.

/** Test seam: bounds one execute's receipt wait (production: three minutes). */
export const internals = { executeTimeoutMs: 180_000 };

/** Chain read-back verdict: committed, provably absent, or unreadable. */
export type VerifyResult<T> =
  | { state: "committed"; value: T }
  | { state: "absent" }
  | { state: "unreadable" };

/** Where one `run` result came from: this call sent, the ledger replayed, or chain read-back verified. */
export interface RunResult<T> {
  value: T;
  source: "sent" | "ledger" | "verified";
}

/** Options for {@link ExecuteLedger.run}. */
export interface RunOptions<T> {
  /** Bound for this caller's wait (the send itself is never cancelled). */
  timeoutMs: number;
  /** Ambiguous-timeout error (thrown to the caller; the attempt stays live). */
  onTimeout: (ms: number) => Error;
  /** Chain read-back consulted before sending (restart cover). */
  verify?: () => Promise<VerifyResult<T>>;
}

interface Attempt {
  status: "starting" | "running" | "settled" | "failed";
  value?: unknown;
  promise: Promise<unknown>;
}

/** Stable attempt key for one launch intent (invalid args throw, as in the send path). */
export function launchKeyFor(args: IntentArgs): string {
  const intent = buildIntent(args);
  return `launch:${createHash("sha256").update(JSON.stringify(jsonSafe(intent))).digest("hex")}`;
}

/** Stable attempt key for one sweep (router, floor). */
export function sweepKeyFor(args: SweepArgs): string {
  const router = assertAddress(args.router, "router");
  const minOut = args.minOut === undefined ? 0n : big(args.minOut, "minOut");
  return `sweep:${router.toLowerCase()}:${minOut.toString()}`;
}

/** Stable attempt key for one heartbeat (router). */
export function heartbeatKeyFor(args: HeartbeatArgs): string {
  return `heartbeat:${assertAddress(args.router, "router").toLowerCase()}`;
}

/** Race one send against this caller's deadline (the send itself is never cancelled). */
function raceTimeout<T>(work: Promise<T>, ms: number, onTimeout: (ms: number) => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return Promise.race([
      work,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(onTimeout(ms)), ms);
      }),
    ]);
  } finally {
    // The timer belongs to the race, not the work: release it when the
    // work settles (clearing an already-fired timer is a no-op).
    if (timer !== undefined) {
      const release = timer;
      void work.then(() => clearTimeout(release), () => clearTimeout(release));
    }
  }
}

/**
 * One attempt ledger per plugin mount: concurrent runs for one key share a
 * single send, settled runs replay, and a timed-out caller leaves the send
 * running so the retry finds the late result instead of double-sending.
 */
export class ExecuteLedger {
  private readonly attempts = new Map<string, Attempt>();

  /**
   * Run one keyed send exactly once.
   * @param key - the attempt key (launch/sweep/heartbeat key fn).
   * @param send - the send itself (already wallet-lane-wrapped by the caller).
   * @param opts - timeout plus optional chain read-back.
   * @returns the value and where it came from.
   */
  run<T>(key: string, send: () => Promise<T>, opts: RunOptions<T>): Promise<RunResult<T>> {
    const prior = this.attempts.get(key) as Attempt | undefined;
    if (prior !== undefined && prior.status === "settled") {
      return Promise.resolve({ value: prior.value as T, source: "ledger" as const });
    }
    if (prior !== undefined && prior.status !== "failed") {
      return (prior.promise as Promise<T>).then(value => ({ value, source: "ledger" as const }));
    }
    // Claim the key synchronously: concurrent runs attach to the gate
    // instead of verifying/sending twice.
    let resolveGate!: (value: T) => void;
    let rejectGate!: (error: unknown) => void;
    const gate = new Promise<T>((resolve, reject) => {
      resolveGate = resolve;
      rejectGate = reject;
    });
    // Followers attach via derived promises; sink the base rejection.
    void gate.catch(() => undefined);
    this.attempts.set(key, { status: "starting", promise: gate as Promise<unknown> });
    return this.execute(key, resolveGate, rejectGate, send, opts);
  }

  /** Read-back peek for exactly-once hooks: replay, unknown, or undefined (verify, then send). */
  peek(key: string): { kind: "replay"; value: unknown } | { kind: "unknown" } | undefined {
    const prior = this.attempts.get(key);
    if (prior === undefined || prior.status === "failed") return undefined;
    if (prior.status === "settled") return { kind: "replay", value: prior.value };
    return { kind: "unknown" };
  }

  private async execute<T>(
    key: string,
    resolveGate: (value: T) => void,
    rejectGate: (error: unknown) => void,
    send: () => Promise<T>,
    opts: RunOptions<T>,
  ): Promise<RunResult<T>> {
    if (opts.verify !== undefined) {
      let verdict: VerifyResult<T>;
      try {
        verdict = await opts.verify();
      } catch {
        verdict = { state: "unreadable" };
      }
      if (verdict.state === "committed") {
        this.attempts.set(key, { status: "settled", value: verdict.value, promise: Promise.resolve(verdict.value) });
        resolveGate(verdict.value);
        return { value: verdict.value, source: "verified" };
      }
      // Absent or unreadable: fall through to the send (an unreadable
      // chain fails loud inside the send's own reads).
    }
    let task: Promise<T>;
    try {
      task = send();
    } catch (error: unknown) {
      // Thrown before anything was sent (invalid args): retryable, no record.
      this.attempts.set(key, { status: "failed", promise: Promise.reject(error) });
      this.attempts.get(key)?.promise.catch(() => undefined);
      rejectGate(error);
      throw error;
    }
    this.attempts.set(key, { status: "running", promise: task as Promise<unknown> });
    // Late settle: the raced send is never cancelled, so record whatever
    // it eventually decides for the retry. Sink the derived rejection —
    // the base task's rejection still reaches the racer and followers.
    void task.then(
      (value) => {
        this.attempts.set(key, { status: "settled", value, promise: Promise.resolve(value) });
        resolveGate(value);
      },
      (error: unknown) => {
        if (this.attempts.get(key)?.status === "running") {
          this.attempts.set(key, { status: "failed", promise: Promise.reject(error) });
          this.attempts.get(key)?.promise.catch(() => undefined);
        }
        rejectGate(error);
      },
    ).catch(() => undefined);
    const value = await raceTimeout(task, opts.timeoutMs, opts.onTimeout);
    return { value, source: "sent" };
  }
}

/**
 * Commit-point read-back for `rr_launch`: the mint.club token address is a
 * deterministic clone over (bond, symbol), so `bond.exists` plus a token
 * name match proves OUR launch mined. A symbol held by someone else's
 * token reads as absent — the send path's own symbol check then fails
 * loud before broadcasting, so a mistaken re-send is impossible.
 */
export async function verifyLaunch(
  client: PublicClient,
  deployment: Deployment,
  args: IntentArgs,
): Promise<VerifyResult<unknown>> {
  let intent: LaunchIntent;
  try {
    intent = buildIntent(args);
  } catch {
    return { state: "unreadable" }; // invalid args: let the send surface the real error
  }
  const token = predictTokenAddress(deployment, intent.symbol);
  let taken: unknown;
  try {
    taken = await client.readContract({ address: deployment.bond, abi: bondAbi, functionName: "exists", args: [token] });
  } catch {
    return { state: "unreadable" };
  }
  if (taken !== true) return { state: "absent" };
  let name: unknown;
  try {
    name = await client.readContract({ address: token, abi: erc20Abi, functionName: "name" });
  } catch {
    name = undefined;
  }
  if (name !== intent.name) return { state: "absent" };
  // The original result (launch hash, router) is unrecoverable — only the
  // commitment itself is provable — so the replay value says exactly that.
  return {
    state: "committed",
    value: {
      hash: `unknown:verified-on-chain:${token}`,
      token,
      router: `unknown:verified-on-chain (token ${token} holds symbol ${intent.symbol})`,
      poolId: poolIdOf(poolKeyFor(
        deployment,
        token,
        intent.secondary ?? ZERO,
        intent.fee ?? 3000,
        intent.tickSpacing ?? 60,
      )),
    },
  };
}

/**
 * Commit-point read-back for `rr_sweep`: a router that is no longer ready
 * (pending cleared below MIN_CLAIM) has been swept — by us or a fellow
 * keeper; either way the keeper action holds and re-sweeping would revert
 * or no-op.
 */
export async function verifySweep(client: PublicClient, router: `0x${string}`): Promise<VerifyResult<unknown>> {
  let status: { ready: boolean };
  try {
    status = await routerStatus(client, router);
  } catch {
    return { state: "unreadable" };
  }
  if (status.ready) return { state: "absent" };
  return {
    state: "committed",
    value: { hash: `unknown:verified-by-router-state:${router}`, status: "success" },
  };
}
