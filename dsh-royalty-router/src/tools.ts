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

import type { PublicClient, WalletClient } from "viem";
import {
  adviseIntent,
  bandBps,
  buildLaunch,
  crossoverSize,
  heartbeat,
  launch,
  poolIdOf,
  poolKeyFor,
  quoteVenues,
  readVenueState,
  recommendedIntent,
  sweep,
  ZERO,
  type Deployment,
  type LaunchIntent,
} from "@royalty-router/sdk";

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
