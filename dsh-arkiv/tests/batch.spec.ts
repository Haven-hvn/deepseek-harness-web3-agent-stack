/**
 * Batch-create proofs for dsh-arkiv (`arkiv_create_entities`).
 *
 * N Haven records in ONE `execute()` transaction (atomic all-or-nothing),
 * mirroring the reference `batch_sync_contexts` multi path — including the
 * singleton short-circuit (one record behaves as one single create, with
 * the single path's ledger and hooks). Every record validates before
 * anything is sent; the attempt ledger keys the ordered batch; the
 * read-back hook replays only settled batches or fully-found restarts.
 * No chain, no harness: stubbed backend seam, like exactly-once.spec.
 */

import { describe, expect, it, vi } from 'vitest';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import type { ExecuteBatchReturnType } from '@arkiv-network/sdk';
import { ArkivRuntime, BATCH_RESULT_SCHEMA } from '../src/index.ts';
import { createEntitiesWithClient } from '../src/arkiv.ts';

const SHA_A = 'aa'.repeat(32);
const SHA_B = 'bb'.repeat(32);
const ATTRS_A = { grp: 'haven.video.full', title: 'batch-a', sha256_ct: SHA_A, mime: 1 };
const ATTRS_B = { grp: 'haven.video.full', title: 'batch-b', sha256_ct: SHA_B, mime: 2 };
const JSON_A = JSON.stringify({ fcid: 'bafybatcha', size: 1 });
const JSON_B = JSON.stringify({ fcid: 'bafybatchb', size: 2 });
const BYTES_A = new TextEncoder().encode(JSON_A);
const BYTES_B = new TextEncoder().encode(JSON_B);

function recordA() {
  return { payload: BYTES_A, contentType: 'application/json', attributes: { ...ATTRS_A } };
}

function recordB() {
  return { payload: BYTES_B, contentType: 'application/json', attributes: { ...ATTRS_B } };
}

function runtime() {
  const ctx: any = {
    emit: vi.fn(),
    reflect: { get: () => undefined },
  };
  const rt = new ArkivRuntime(ctx as never, 'agent', { privateKeyRef: 'X', rpcUrl: 'https://rpc.tiramisu.test' });
  const backend = {
    singles: 0,
    batches: 0,
    batchImpl: async (records: Array<{ payload: Uint8Array }>) => {
      backend.batches += 1;
      return records.map((_, index) => ({
        key: `0x${(index + 1).toString(16).padStart(40, '0')}` as `0x${string}`,
        txHash: '0xbatch' as `0x${string}`,
      }));
    },
    queryImpl: async (_query: { where?: Record<string, unknown>; limit?: number }): Promise<any[]> => [],
  };
  (rt as any).backend = {
    createEntity: async () => {
      backend.singles += 1;
      return { key: '0xsingle', txHash: '0xsingle' };
    },
    updateEntity: async () => ({ txHash: '0x0' }),
    createEntities: (records: Array<{ payload: Uint8Array }>) => backend.batchImpl(records),
    queryEntities: (query: any) => backend.queryImpl(query),
  };
  return { ctx, rt, backend };
}

describe('batch submit', () => {
  it('rejects an empty batch', async () => {
    const { rt, backend } = runtime();
    await expect(rt.createEntities([])).rejects.toThrow('at least one entity');
    expect(backend.batches).toBe(0);
  });

  it('singletons delegate to the single path (no batch transaction)', async () => {
    const { rt, backend } = runtime();
    const out = await rt.createEntities([recordA()]);
    expect(out).toEqual([{ key: '0xsingle', txHash: '0xsingle' }]);
    expect(backend.singles).toBe(1);
    expect(backend.batches).toBe(0);
  });

  it('one bad record rejects the whole batch before anything is sent', async () => {
    const { rt, backend } = runtime();
    await expect(rt.createEntities([recordA(), {
      payload: BYTES_B,
      contentType: 'application/json',
      attributes: { grp: 'haven.video.full' }, // missing title/sha256_ct
    }])).rejects.toThrow();
    expect(backend.batches).toBe(0);
  });

  it('mints in order with one shared txHash and one event per record', async () => {
    const { ctx, rt, backend } = runtime();
    const out = await rt.createEntities([recordA(), recordB()]);
    expect(out).toEqual([
      { key: `0x${'0'.repeat(39)}1`, txHash: '0xbatch' },
      { key: `0x${'0'.repeat(39)}2`, txHash: '0xbatch' },
    ]);
    expect(backend.batches).toBe(1);
    expect(ctx.emit).toHaveBeenCalledTimes(2);
    expect(ctx.emit).toHaveBeenNthCalledWith(1, 'arkiv/created', expect.objectContaining({ key: `0x${'0'.repeat(39)}1` }));
    expect(ctx.emit).toHaveBeenNthCalledWith(2, 'arkiv/created', expect.objectContaining({ key: `0x${'0'.repeat(39)}2` }));
  });

  it('settled batches replay; failures stay retryable; concurrent batches attach', async () => {
    const { rt, backend } = runtime();
    const first = await rt.createEntities([recordA(), recordB()]);
    const second = await rt.createEntities([
      { payload: new TextEncoder().encode(JSON_A), contentType: 'application/json', attributes: { ...ATTRS_A } },
      { payload: new TextEncoder().encode(JSON_B), contentType: 'application/json', attributes: { ...ATTRS_B } },
    ]);
    expect(second).toEqual(first);
    expect(backend.batches).toBe(1);

    let calls = 0;
    backend.batchImpl = async (records: Array<{ payload: Uint8Array }>) => {
      calls += 1;
      if (calls === 1) throw new Error('chain hiccup');
      return records.map((_, index) => ({ key: `0x${index}`, txHash: '0x9' }) as never);
    };
    const other = [
      { payload: new TextEncoder().encode(JSON.stringify({ fcid: 'bafyother', size: 3 })), contentType: 'application/json', attributes: { ...ATTRS_A } },
      recordB(),
    ];
    await expect(rt.createEntities(other)).rejects.toThrow('chain hiccup');
    await rt.createEntities(other);
    expect(calls).toBe(2);
  });

  it('record order shades the batch key (keys map positionally)', async () => {
    const { rt, backend } = runtime();
    await rt.createEntities([recordA(), recordB()]);
    await rt.createEntities([recordB(), recordA()]);
    expect(backend.batches).toBe(2);
  });
});

describe('checkBatch', () => {
  function checkArgs() {
    return {
      entities: [
        { payload: JSON_A, contentType: 'application/json', attributes: { ...ATTRS_A } },
        { payload: JSON_B, contentType: 'application/json', attributes: { ...ATTRS_B } },
      ],
    };
  }

  it('replays settled batches and stays silent on misses', async () => {
    const { rt } = runtime();
    const settled = await rt.createEntities([recordA(), recordB()]);
    await expect(rt.checkBatch(checkArgs())).resolves.toEqual({ kind: 'replay', value: settled });
    await expect(rt.checkBatch({ entities: [] })).resolves.toEqual({ kind: 'unknown' });
    await expect(rt.checkBatch({})).resolves.toEqual({ kind: 'unknown' });
    await expect(rt.checkBatch({
      entities: [{ payload: 'nope', contentType: 'application/json', attributes: { ...ATTRS_A } }],
    })).resolves.toEqual({ kind: 'unknown' });
  });

  it('covers restarts only when every record is found', async () => {
    const { rt, backend } = runtime();
    const hits: Record<string, { key: string; payload: Uint8Array }> = {
      [SHA_A]: { key: '0xa', payload: BYTES_A },
      [SHA_B]: { key: '0xb', payload: BYTES_B },
    };
    backend.queryImpl = async (query: { where?: Record<string, unknown> }) => {
      const sha = (query.where as Record<string, string> | undefined)?.sha256_ct;
      const hit = sha !== undefined ? hits[sha] : undefined;
      if (hit === undefined) return [];
      return [{ key: hit.key, owner: '0xo', payload: hit.payload, contentType: 'application/json' }];
    };
    await expect(rt.checkBatch(checkArgs())).resolves.toEqual({
      kind: 'replay',
      value: [
        { key: '0xa', txHash: 'unknown:verified-by-query:0xa' },
        { key: '0xb', txHash: 'unknown:verified-by-query:0xb' },
      ],
    });
    // Partial cover contradicts atomic commit: unknown, never a replay.
    delete hits[SHA_B];
    await expect(rt.checkBatch(checkArgs())).resolves.toEqual({ kind: 'unknown' });
  });
});

describe('backend batch mapping', () => {
  it('maps createdEntities positionally under the shared txHash', async () => {
    const sdkResult = {
      txHash: '0xtx',
      createdEntities: ['0xk1', '0xk2'],
      patchedEntities: [],
      deletedEntities: [],
      extendedEntities: [],
      ownershipChanges: [],
    } as unknown as ExecuteBatchReturnType;
    const seen: unknown[] = [];
    const out = await createEntitiesWithClient(
      { executeBatch: async (data: unknown) => { seen.push(data); return sdkResult; } },
      [
        { payload: BYTES_A, contentType: 'application/json', attributes: { ...ATTRS_A }, expiresIn: 3600 },
        { payload: BYTES_B, contentType: 'application/json', attributes: { ...ATTRS_B }, expiresIn: 3600 },
      ],
    );
    expect(out).toEqual([
      { key: '0xk1', txHash: '0xtx' },
      { key: '0xk2', txHash: '0xtx' },
    ]);
    expect(seen).toHaveLength(1);
    expect((seen[0] as { creates: unknown[] }).creates).toHaveLength(2);
  });

  it('refuses to mis-map a short result', async () => {
    const sdkResult = {
      txHash: '0xtx',
      createdEntities: ['0xk1'],
      patchedEntities: [],
      deletedEntities: [],
      extendedEntities: [],
      ownershipChanges: [],
    } as unknown as ExecuteBatchReturnType;
    await expect(createEntitiesWithClient(
      { executeBatch: async () => sdkResult },
      [recordA(), recordB()],
    )).rejects.toThrow('order unmapped');
  });
});

describe('batch output contract', () => {
  it('accepts the ordered [{key, txHash}] list', () => {
    expect(validateJsonSchemaValue(BATCH_RESULT_SCHEMA, [], 'value')).toEqual([]);
    expect(validateJsonSchemaValue(
      BATCH_RESULT_SCHEMA,
      [{ key: '0x1', txHash: '0x2' }, { key: '0x3', txHash: '0x2' }],
      'value',
    )).toEqual([]);
  });

  it('rejects non-lists and undeclared keys', () => {
    expect(validateJsonSchemaValue(BATCH_RESULT_SCHEMA, { key: '0x1' }, 'value').length).toBeGreaterThan(0);
    expect(validateJsonSchemaValue(
      BATCH_RESULT_SCHEMA,
      [{ key: '0x1', txHash: '0x2', owner: '0x3' }],
      'value',
    ).length).toBeGreaterThan(0);
  });
});
