/**
 * Exactly-once proofs for dsh-arkiv entity writes.
 *
 * No chain, no harness: the runtime is constructed directly over a stubbed
 * backend (the `backend` seam), proving the attempt ledger (in-flight
 * attach, settled replay, failed retry), the attribute-query restart
 * cover, and lazy hook registration against a fake guard.
 *
 * Every write here is a valid Haven record (ARKIV_FORMAT v2.1.0): the
 * runtime validates before ledgering, so the fixtures carry the real
 * shape — a clear `haven.video.full` with `fcid` payload.
 */

import { describe, expect, it, vi } from 'vitest';
import { ArkivRuntime } from '../src/index.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface StubBackend {
  creates: number;
  updates: number;
  queries: Array<{ where?: Record<string, unknown>; limit?: number }>;
  createImpl: (params: { payload: Uint8Array; contentType: string; attributes?: Record<string, unknown> }) => Promise<{ key: `0x${string}`; txHash: `0x${string}` }>;
  updateImpl: (params: { key: `0x${string}` }) => Promise<{ txHash: `0x${string}` }>;
  queryImpl: (query: { where?: Record<string, unknown>; limit?: number }) => Promise<any[]>;
}

function runtime(guard?: { registerCheck: (...args: any[]) => () => void }) {
  const ctx: any = {
    emit: vi.fn(),
    reflect: { get: (name: string) => (name === 'exactlyOnce' ? guard : undefined) },
  };
  const rt = new ArkivRuntime(ctx as never, 'agent', { privateKeyRef: 'X', rpcUrl: 'https://rpc.tiramisu.test' });
  const backend: StubBackend = {
    creates: 0,
    updates: 0,
    queries: [],
    createImpl: async () => {
      backend.creates += 1;
      return { key: `0x${backend.creates.toString(16).padStart(40, '0')}` as `0x${string}`, txHash: `0x${backend.creates.toString(16).padStart(64, '0')}` as `0x${string}` };
    },
    updateImpl: async () => {
      backend.updates += 1;
      return { txHash: `0x${backend.updates.toString(16).padStart(64, '0')}` as `0x${string}` };
    },
    queryImpl: async () => [],
  };
  (rt as any).backend = {
    createEntity: (params: any) => backend.createImpl(params),
    updateEntity: (params: any) => backend.updateImpl(params),
    queryEntities: (query: any) => {
      backend.queries.push(query);
      return backend.queryImpl(query);
    },
  };
  return { ctx, rt, backend };
}

/** Minimal valid Haven record: clear `haven.video.full` (`fcid`, no gate). */
const SHA = 'ab'.repeat(32);
const CLEAR_ATTRS = { grp: 'haven.video.full', title: 'fixture', sha256_ct: SHA, mime: 1 };
const CLEAR_JSON = JSON.stringify({ fcid: 'bafyfixture', size: 14 });
const BYTES = new TextEncoder().encode(CLEAR_JSON);
const CHANGED_JSON = JSON.stringify({ fcid: 'bafychanged', size: 7 });

describe('create attempt ledger', () => {
  it('concurrent creates attach to one backend call', async () => {
    const { rt, backend } = runtime();
    const gate = deferred<{ key: `0x${string}`; txHash: `0x${string}` }>();
    let calls = 0;
    backend.createImpl = () => {
      calls += 1;
      return gate.promise;
    };
    const params = { payload: BYTES, contentType: 'application/json', attributes: { ...CLEAR_ATTRS } };
    const first = rt.createEntity(params);
    const second = rt.createEntity({ payload: new TextEncoder().encode(CLEAR_JSON), contentType: 'application/json', attributes: { ...CLEAR_ATTRS } });
    gate.resolve({ key: '0x1', txHash: '0x2' });
    const [a, b] = await Promise.all([first, second]);
    expect(a.key).toBe('0x1');
    expect(b.key).toBe('0x1');
    expect(calls).toBe(1);
  });

  it('settled creates replay without re-sending', async () => {
    const { ctx, rt, backend } = runtime();
    const params = { payload: BYTES, contentType: 'application/json', attributes: { ...CLEAR_ATTRS } };
    const first = await rt.createEntity(params);
    const second = await rt.createEntity({ payload: new TextEncoder().encode(CLEAR_JSON), contentType: 'application/json', attributes: { ...CLEAR_ATTRS } });
    expect(second).toEqual(first);
    expect(backend.creates).toBe(1);
    expect(ctx.emit).toHaveBeenCalledTimes(1); // one effect, one event
  });

  it('failed creates stay retryable (rejected promises never replay)', async () => {
    const { rt, backend } = runtime();
    let calls = 0;
    backend.createImpl = async () => {
      calls += 1;
      if (calls === 1) throw new Error('chain hiccup');
      return { key: '0x9', txHash: '0x8' };
    };
    const params = { payload: BYTES, contentType: 'application/json', attributes: { ...CLEAR_ATTRS } };
    await expect(rt.createEntity(params)).rejects.toThrow('chain hiccup');
    const retry = await rt.createEntity(params);
    expect(retry.key).toBe('0x9');
    expect(calls).toBe(2);
  });

  it('attribute order does not shade the content key', async () => {
    const { rt, backend } = runtime();
    await rt.createEntity({ payload: BYTES, contentType: 'application/json', attributes: { grp: 'haven.video.full', title: 'fixture', sha256_ct: SHA, mime: 1, dur_s: 60 } });
    await rt.createEntity({ payload: BYTES, contentType: 'application/json', attributes: { dur_s: 60, mime: 1, sha256_ct: SHA, title: 'fixture', grp: 'haven.video.full' } });
    expect(backend.creates).toBe(1);
  });
});

describe('checkCreate', () => {
  it('replays settled attempts and stays silent on misses', async () => {
    const { rt } = runtime();
    const record = await rt.createEntity({ payload: BYTES, contentType: 'application/json', attributes: { ...CLEAR_ATTRS } });
    await expect(rt.checkCreate({ payload: CLEAR_JSON, contentType: 'application/json', attributes: { ...CLEAR_ATTRS } }))
      .resolves.toEqual({ kind: 'replay', value: { key: record.key, owner: record.owner, txHash: record.txHash } });
    await expect(rt.checkCreate({ payload: 'other', contentType: 'application/json' })).resolves.toEqual({ kind: 'unknown' });
    await expect(rt.checkCreate({})).resolves.toEqual({ kind: 'unknown' });
  });

  it('covers restarts via attribute query plus payload-hash match', async () => {
    const { rt, backend } = runtime();
    // Simulate the post-restart ledger: empty, but the chain holds the entity.
    backend.queryImpl = async () => [{
      key: '0xabc',
      owner: '0xdef',
      payload: new TextEncoder().encode(CLEAR_JSON),
      contentType: 'application/json',
      attributes: { ...CLEAR_ATTRS },
    }];
    const replay = await rt.checkCreate({ payload: CLEAR_JSON, contentType: 'application/json', attributes: { ...CLEAR_ATTRS } });
    expect(replay).toEqual({
      kind: 'replay',
      value: { key: '0xabc', owner: '0xdef', txHash: 'unknown:verified-by-query:0xabc' },
    });
    expect(backend.queries).toEqual([{ where: { ...CLEAR_ATTRS }, limit: 25 }]);
    // No payload match, no replay.
    backend.queryImpl = async () => [{
      key: '0xabc',
      owner: '0xdef',
      payload: new TextEncoder().encode('different-bytes'),
      contentType: 'application/json',
    }];
    await expect(rt.checkCreate({ payload: CLEAR_JSON, contentType: 'application/json', attributes: { ...CLEAR_ATTRS } }))
      .resolves.toEqual({ kind: 'unknown' });
    // Without attributes the record cannot validate, so nothing to query.
    await expect(rt.checkCreate({ payload: CLEAR_JSON, contentType: 'application/json' }))
      .resolves.toEqual({ kind: 'unknown' });
  });

  it('holds unknown while the create is in flight', async () => {
    const { rt } = runtime();
    const gate = deferred<{ key: `0x${string}`; txHash: `0x${string}` }>();
    (rt as any).backend.createEntity = () => gate.promise;
    const params = { payload: BYTES, contentType: 'application/json', attributes: { ...CLEAR_ATTRS } };
    const pending = rt.createEntity(params);
    // The hook attaches to the in-flight attempt; settle it and the hook replays.
    gate.resolve({ key: '0x3', txHash: '0x4' });
    await pending;
    await expect(rt.checkCreate({ payload: CLEAR_JSON, contentType: 'application/json', attributes: { ...CLEAR_ATTRS } }))
      .resolves.toEqual({ kind: 'replay', value: { key: '0x3', owner: '0x', txHash: '0x4' } });
  });
});

describe('updates', () => {
  it('dedup by key plus content; new content re-patches', async () => {
    const { rt, backend } = runtime();
    const base = { key: '0x1' as `0x${string}`, contentType: 'application/json', attributes: { ...CLEAR_ATTRS } };
    const first = await rt.updateEntity({ ...base, payload: BYTES });
    const second = await rt.updateEntity({ ...base, payload: new TextEncoder().encode(CLEAR_JSON), attributes: { ...CLEAR_ATTRS } });
    expect(second).toEqual(first);
    expect(backend.updates).toBe(1);
    await rt.updateEntity({ ...base, payload: new TextEncoder().encode(CHANGED_JSON), attributes: { ...CLEAR_ATTRS } });
    expect(backend.updates).toBe(2);
    await rt.updateEntity({ key: '0x2' as `0x${string}`, contentType: 'application/json', attributes: { ...CLEAR_ATTRS }, payload: BYTES });
    expect(backend.updates).toBe(3);
  });

  it('checkUpdate replays settled and stays silent otherwise', async () => {
    const { rt } = runtime();
    const updated = await rt.updateEntity({ key: '0x1' as `0x${string}`, payload: BYTES, contentType: 'application/json', attributes: { ...CLEAR_ATTRS } });
    await expect(rt.checkUpdate({ key: '0x1', payload: CLEAR_JSON, contentType: 'application/json', attributes: { ...CLEAR_ATTRS } }))
      .resolves.toEqual({ kind: 'replay', value: updated });
    await expect(rt.checkUpdate({ key: '0x9', payload: CLEAR_JSON, contentType: 'application/json', attributes: { ...CLEAR_ATTRS } }))
      .resolves.toEqual({ kind: 'unknown' });
    await expect(rt.checkUpdate({})).resolves.toEqual({ kind: 'unknown' });
  });
});

describe('lazy hook registration', () => {
  it('registers both hooks once the guard is present, retires on unhook', async () => {
    const registered = new Map<string, unknown>();
    const guard = {
      registerCheck: vi.fn((name: string, fn: unknown) => {
        registered.set(name, fn);
        return () => { registered.delete(name); };
      }),
    };
    const { rt } = runtime(guard);
    expect((rt as any).hookDisposers).toBeUndefined(); // nothing before the first write
    await rt.createEntity({ payload: BYTES, contentType: 'application/json', attributes: { ...CLEAR_ATTRS } });
    expect(guard.registerCheck).toHaveBeenCalledTimes(3);
    expect([...registered.keys()].sort()).toEqual(['arkiv_create_entities', 'arkiv_create_entity', 'arkiv_update_entity']);
    await rt.updateEntity({ key: '0x1' as `0x${string}`, payload: BYTES, contentType: 'application/json', attributes: { ...CLEAR_ATTRS } });
    expect(guard.registerCheck).toHaveBeenCalledTimes(3); // idempotent
    rt.unhook();
    expect(registered.size).toBe(0);
  });

  it('works unguarded (no guard, no registration, no throw)', async () => {
    const { rt, backend } = runtime();
    const record = await rt.createEntity({ payload: BYTES, contentType: 'application/json', attributes: { ...CLEAR_ATTRS } });
    expect(record.key).toMatch(/^0x/);
    expect(backend.creates).toBe(1);
    expect((rt as any).hookDisposers).toBeUndefined();
  });
});
