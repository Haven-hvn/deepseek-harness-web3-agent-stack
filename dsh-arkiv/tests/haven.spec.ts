/**
 * Haven application-protocol proofs for dsh-arkiv writes.
 *
 * The runtime validates every create/update against ARKIV_FORMAT v2.1.0
 * BEFORE signing (see ../src/haven.ts, ported from
 * the reference services/arkiv_sync.py). These specs pin the per-group record
 * shapes, the attr↔gate cross-checks, the reference-compatible wire
 * normalization, and the runtime wiring (invalid ⇒ throw before send).
 * No chain, no network.
 */

import { describe, expect, it, vi } from 'vitest';
import type { CreateEntityReturnType } from '@arkiv-network/sdk';
import { ArkivRuntime } from '../src/index.ts';
import { createEntityWithClient } from '../src/arkiv.ts';
import {
  HAVEN_BTL_FULL_S,
  HAVEN_BTL_PART_S,
  HAVEN_BTL_SERIES_S,
  normalizeHavenWhere,
  validateHavenWrite,
} from '../src/haven.ts';

const TOKEN = `0x${'ab'.repeat(20)}`;
const SHA = 'cd'.repeat(32);
const SERIES_REF = `0x${'11'.repeat(32)}`;
const ORACLE = `0x${'22'.repeat(20)}`;
const DRIP_ID = '123e4567-e89b-12d3-a456-426614174000';

const gateV1 = () => ({
  version: 1,
  cid: 'bafkzcibsealed',
  chain: 'BaseMainnet',
  tokenAddress: TOKEN,
  threshold: '1',
  encryptedAesKey: 'YmFzZTY0',
});

const gateV3 = () => ({
  version: 3,
  cid: 'bafkzcibsealed',
  chain: 'BaseMainnet',
  tokenAddress: TOKEN,
  threshold: '0',
  epoch: 12,
  encryptedAesKey: 'YmFzZTY0',
});

const gateV4 = () => ({
  version: 4,
  cid: 'bafkzcibsealed',
  chain: 'BaseMainnet',
  tokenAddress: TOKEN,
  threshold: '5',
  epoch: 9,
  marketCapTarget: 100,
  oracleAddress: ORACLE,
  encryptedAesKey: 'eA==',
});

function fullV1() {
  return {
    payload: new TextEncoder().encode(JSON.stringify({
      piece: 'bafkzcibpiece',
      gate: JSON.stringify(gateV1()),
      size: 1024,
      pt_hash: `0x${'ef'.repeat(32)}`,
      src: 'https://example.invalid/x',
      creator: '@herald',
      vlm: 'bafyvlm',
      vlm_model: 'glm-4.6v-flash',
      codecs: ['h264'],
      seg: { segment_index: 0 },
      attn: { signature: '0x00' },
      x: { idx: 'prowlarr' },
    })),
    contentType: 'application/json',
    attributes: {
      grp: 'haven.video.full',
      title: 'Premiere',
      gate_type: 1,
      gate_token: TOKEN,
      gate_chain: 8453,
      gate_threshold: 1,
      sha256_ct: SHA,
      mime: 1,
      dur_s: 90,
    },
  };
}

function fullV3() {
  const base = fullV1();
  return {
    payload: new TextEncoder().encode(JSON.stringify({
      piece: 'bafkzcibpiece3',
      gate: JSON.stringify(gateV3()),
      size: 2048,
    })),
    contentType: 'application/json',
    attributes: {
      grp: 'haven.video.full',
      title: 'Epoch drop',
      gate_type: 3,
      gate_token: TOKEN,
      gate_chain: 8453,
      gate_threshold: 0,
      gate_epoch: 12,
      sha256_ct: SHA,
      mime: 2,
    },
  };
}

function fullClear() {
  return {
    payload: new TextEncoder().encode(JSON.stringify({ fcid: 'bafyclear', size: 5 })),
    contentType: 'application/json',
    attributes: { grp: 'haven.video.full', title: 'Freebie', sha256_ct: SHA, mime: 12 },
  };
}

function genericImage() {
  return {
    payload: new TextEncoder().encode(JSON.stringify({
      piece: 'bafkzcibimg',
      gate: JSON.stringify(gateV1()),
      name: 'pic.png',
      size: 42,
    })),
    contentType: 'application/json',
    attributes: {
      grp: 'haven.image.full',
      title: 'pic.png',
      gate_type: 1,
      gate_token: TOKEN,
      gate_chain: 8453,
      gate_threshold: 1,
      sha256_ct: SHA,
      mime: 8,
    },
  };
}

function genericCtFile() {
  return {
    payload: new TextEncoder().encode(JSON.stringify({
      fcid: 'bafybook',
      name: 'book.epub',
      ct: 'application/epub+zip',
      size: 7,
    })),
    contentType: 'application/json',
    attributes: { grp: 'haven.file.full', title: 'book.epub', sha256_ct: SHA },
  };
}

function dripSeries() {
  return {
    payload: new TextEncoder().encode(JSON.stringify({ targets: [100, 500, 1000], creator: '@herald', mime: 1 })),
    contentType: 'application/json',
    attributes: {
      grp: 'haven.video.drip.series',
      title: 'Drip run',
      gate_type: 4,
      gate_token: TOKEN,
      gate_chain: 8453,
      gate_threshold: 5,
      drip_id: DRIP_ID,
      drip_total: 3,
    },
  };
}

function dripPart() {
  return {
    payload: new TextEncoder().encode(JSON.stringify({ piece: 'bafkzcibpart', gate: JSON.stringify(gateV4()) })),
    contentType: 'application/json',
    attributes: {
      grp: 'haven.video.drip.part',
      gate_type: 4,
      drip_id: DRIP_ID,
      drip_idx: 0,
      series_ref: SERIES_REF,
      mcap_usd: 100,
      sha256_ct: SHA,
    },
  };
}

describe('haven writes: valid records pass', () => {
  it.each([
    ['v1 full', fullV1],
    ['v3 full', fullV3],
    ['clear full', fullClear],
    ['generic image', genericImage],
    ['generic ct file', genericCtFile],
    ['drip series', dripSeries],
    ['drip part', dripPart],
  ])('%s validates', (_name, build) => {
    const write = validateHavenWrite(build());
    expect(write.contentType).toBe('application/json');
  });

  it('custom grp overrides follow the generic-file record', () => {
    const record = genericImage();
    record.attributes.grp = 'acme.reports.full';
    const write = validateHavenWrite(record);
    expect(write.grp).toBe('acme.reports.full');
    expect(write.grpClass).toBe('generic');
  });
});

describe('haven writes: normalization', () => {
  it('lowercases hex to the reference wire (full groups stay str|int)', () => {
    const record = fullV1();
    record.attributes.gate_token = TOKEN.toUpperCase().replace('0X', '0x');
    record.attributes.sha256_ct = `0x${SHA.toUpperCase()}`;
    const write = validateHavenWrite(record);
    expect(write.attributes.gate_token).toBe(TOKEN);
    expect(write.attributes.sha256_ct).toBe(SHA); // bare, like hexdigest()
    expect(typeof write.attributes.gate_type).toBe('number');
  });

  it('wraps drip facts in their spec-tagged SDK values', () => {
    const write = validateHavenWrite(dripPart());
    expect(write.attributes.series_ref).toEqual({ type: 'key', value: SERIES_REF });
    expect(write.attributes.sha256_ct).toEqual({ type: 'bytes32', value: `0x${SHA}` });
    expect(write.attributes.gate_type).toEqual({ type: 'i32', value: 4 });
    expect(write.attributes.drip_id).toEqual({ type: 'str', value: DRIP_ID });
    const series = validateHavenWrite(dripSeries());
    expect(series.attributes.gate_token).toMatchObject({ type: 'addr' });
  });

  it('defaults BTL per group (4w full, 52w series, 12w parts)', () => {
    expect(validateHavenWrite(fullV1()).expiresIn).toBe(HAVEN_BTL_FULL_S);
    expect(validateHavenWrite(genericImage()).expiresIn).toBe(HAVEN_BTL_FULL_S);
    expect(validateHavenWrite(dripSeries()).expiresIn).toBe(HAVEN_BTL_SERIES_S);
    expect(validateHavenWrite(dripPart()).expiresIn).toBe(HAVEN_BTL_PART_S);
  });

  it('respects an explicit expiresIn', () => {
    const record = fullV1();
    expect(validateHavenWrite({ ...record, expiresIn: 3600 }).expiresIn).toBe(3600);
  });
});

describe('haven writes: fail-closed rejections', () => {
  const cases: Array<[string, () => unknown, RegExp]> = [
    ['wrong contentType', () => ({ ...fullV1(), contentType: 'text/plain' }), /application\/json/],
    ['non-JSON payload', () => ({ ...fullV1(), payload: new TextEncoder().encode('entity-payload') }), /JSON object/],
    ['array payload', () => ({ ...fullV1(), payload: new TextEncoder().encode('[]') }), /JSON object/],
    ['missing attributes', () => ({ payload: fullV1().payload, contentType: 'application/json' }), /attributes are required/],
    ['missing grp', () => { const r = fullV1(); const { grp: _d, ...rest } = r.attributes; return { ...r, attributes: rest }; }, /grp is required/],
    ['malformed grp', () => { const r = fullV1(); return { ...r, attributes: { ...r.attributes, grp: 'Haven.Video' } }; }, /invalid grp/],
    ['single-label grp', () => { const r = fullV1(); return { ...r, attributes: { ...r.attributes, grp: 'single' } }; }, /invalid grp/],
    ['reserved audio grp', () => { const r = fullV1(); return { ...r, attributes: { ...r.attributes, grp: 'haven.audio.full' } }; }, /reserved/],
    ['reserved meta grp', () => { const r = fullV1(); return { ...r, attributes: { ...r.attributes, grp: 'haven.meta.gate' } }; }, /reserved/],
    ['string gate_type', () => { const r = fullV1(); return { ...r, attributes: { ...r.attributes, gate_type: '1' } }; }, /i32 number/],
    ['bool gate_type', () => { const r = fullV1(); return { ...r, attributes: { ...r.attributes, gate_type: true } }; }, /boolean/],
    ['gate_type 2', () => { const r = fullV1(); return { ...r, attributes: { ...r.attributes, gate_type: 2 } }; }, /1\|3/],
    ['gate_type 4 on full', () => { const r = fullV1(); return { ...r, attributes: { ...r.attributes, gate_type: 4 } }; }, /drip/],
    ['missing gate_token', () => { const r = fullV1(); const { gate_token: _d, ...rest } = r.attributes; return { ...r, attributes: rest }; }, /gate_token/],
    ['short token', () => { const r = fullV1(); return { ...r, attributes: { ...r.attributes, gate_token: '0x123' } }; }, /0x address/],
    ['gate token mismatch', () => { const r = fullV1(); return { ...r, attributes: { ...r.attributes, gate_token: `0x${'99'.repeat(20)}` } }; }, /!= gate.tokenAddress/],
    ['unknown gate chain', () => {
      const gate = { ...gateV1(), chain: 'Solana' };
      const r = fullV1();
      return { ...r, payload: new TextEncoder().encode(JSON.stringify({ piece: 'bafkzcibpiece', gate: JSON.stringify(gate) })) };
    }, /not a known Haven-AOL variant/],
    ['gate_chain mismatch', () => { const r = fullV1(); return { ...r, attributes: { ...r.attributes, gate_chain: 1 } }; }, /EIP-155/],
    ['threshold mismatch', () => { const r = fullV1(); return { ...r, attributes: { ...r.attributes, gate_threshold: 5 } }; }, /!= gate.threshold/],
    ['threshold overflow', () => { const r = fullV1(); return { ...r, attributes: { ...r.attributes, gate_threshold: 2 ** 31 } }; }, /i32/],
    ['negative threshold', () => { const r = fullV1(); return { ...r, attributes: { ...r.attributes, gate_threshold: -1 } }; }, />= 0/],
    ['v3 without epoch', () => { const r = fullV3(); const { gate_epoch: _d, ...rest } = r.attributes; return { ...r, attributes: rest }; }, /gate_epoch is required/],
    ['v3 epoch mismatch', () => { const r = fullV3(); return { ...r, attributes: { ...r.attributes, gate_epoch: 13 } }; }, /!= gate.epoch/],
    ['v1 with epoch', () => { const r = fullV1(); return { ...r, attributes: { ...r.attributes, gate_epoch: 1 } }; }, /v3 only/],
    ['gate version mismatch', () => {
      const r = fullV3();
      return { ...r, payload: new TextEncoder().encode(JSON.stringify({ piece: 'bafkzcibpiece3', gate: JSON.stringify(gateV1()) })) };
    }, /!= gate.version/],
    ['gate missing key', () => {
      const gate = { ...gateV1() } as Record<string, unknown>;
      delete gate.encryptedAesKey;
      const r = fullV1();
      return { ...r, payload: new TextEncoder().encode(JSON.stringify({ piece: 'bafkzcibpiece', gate: JSON.stringify(gate) })) };
    }, /missing required v1 key/],
    ['gate bool version', () => {
      const r = fullV1();
      return { ...r, payload: new TextEncoder().encode(JSON.stringify({ piece: 'bafkzcibpiece', gate: JSON.stringify({ ...gateV1(), version: true }) })) };
    }, /got boolean/],
    ['gate version 2', () => {
      const r = fullV1();
      return { ...r, payload: new TextEncoder().encode(JSON.stringify({ piece: 'bafkzcibpiece', gate: JSON.stringify({ ...gateV1(), version: 2 }) })) };
    }, /must be 1, 3, or 4/],
    ['gate not JSON', () => {
      const r = fullV1();
      return { ...r, payload: new TextEncoder().encode(JSON.stringify({ piece: 'bafkzcibpiece', gate: 'nope{' })) };
    }, /not valid JSON/],
    ['missing sha256_ct', () => { const r = fullV1(); const { sha256_ct: _d, ...rest } = r.attributes; return { ...r, attributes: rest }; }, /sha256_ct/],
    ['malformed sha256_ct', () => { const r = fullV1(); return { ...r, attributes: { ...r.attributes, sha256_ct: 'xyz' } }; }, /sha256 digest/],
    ['mime out of enum', () => { const r = fullV1(); return { ...r, attributes: { ...r.attributes, mime: 15 } }; }, /0\.\.14/],
    ['string mime', () => { const r = fullV1(); return { ...r, attributes: { ...r.attributes, mime: '1' } }; }, /i32 number/],
    ['dur_s on generic', () => { const r = genericImage(); return { ...r, attributes: { ...r.attributes, dur_s: 5 } }; }, /video-only/],
    ['negative dur_s', () => { const r = fullV1(); return { ...r, attributes: { ...r.attributes, dur_s: -1 } }; }, />= 0/],
    ['missing title', () => { const r = fullV1(); const { title: _d, ...rest } = r.attributes; return { ...r, attributes: rest }; }, /non-empty str/],
    ['over-long title', () => { const r = fullV1(); return { ...r, attributes: { ...r.attributes, title: 't'.repeat(129) } }; }, /128-byte/],
    ['deleted attr category', () => { const r = fullV1(); return { ...r, attributes: { ...r.attributes, category: 'doc' } }; }, /deleted in 2\.0\.0/],
    ['deleted attr gate_version', () => { const r = fullV1(); return { ...r, attributes: { ...r.attributes, gate_version: 'v1' } }; }, /deleted in 2\.0\.0/],
    ['deleted attr cid_hash', () => { const r = fullV1(); return { ...r, attributes: { ...r.attributes, cid_hash: SHA } }; }, /deleted in 2\.0\.0/],
    ['unknown attr', () => { const r = fullV1(); return { ...r, attributes: { ...r.attributes, frobnicate: 1 } }; }, /not in the .* record/],
    ['reserved attr name', () => { const r = fullV1(); return { ...r, attributes: { ...r.attributes, and: 1 } }; }, /reserved by the query language/],
    ['piece and fcid', () => {
      const r = fullV1();
      return { ...r, payload: new TextEncoder().encode(JSON.stringify({ piece: 'bafkzcibpiece', fcid: 'bafyclear', gate: JSON.stringify(gateV1()) })) };
    }, /never both/],
    ['no locator', () => {
      const r = fullV1();
      return { ...r, payload: new TextEncoder().encode(JSON.stringify({ gate: JSON.stringify(gateV1()) })) };
    }, /exactly one locator/],
    ['piece without gate', () => {
      const r = fullV1();
      return { ...r, payload: new TextEncoder().encode(JSON.stringify({ piece: 'bafkzcibpiece' })) };
    }, /requires the gate/],
    ['clear with gate attrs', () => { const r = fullClear(); return { ...r, attributes: { ...r.attributes, gate_type: 1 } }; }, /must not carry gate_type/],
    ['clear with gate payload', () => {
      const r = fullClear();
      return { ...r, payload: new TextEncoder().encode(JSON.stringify({ fcid: 'bafyclear', gate: JSON.stringify(gateV1()) })) };
    }, /must not carry gate/],
    ['old key piece_cid', () => {
      const r = fullClear();
      return { ...r, payload: new TextEncoder().encode(JSON.stringify({ fcid: 'bafyclear', piece_cid: 'bafk' })) };
    }, /renamed to/],
    ['old key encryption_metadata', () => {
      const r = fullClear();
      return { ...r, payload: new TextEncoder().encode(JSON.stringify({ fcid: 'bafyclear', encryption_metadata: '{}' })) };
    }, /renamed to/],
    ['old key original_hash', () => {
      const r = fullClear();
      return { ...r, payload: new TextEncoder().encode(JSON.stringify({ fcid: 'bafyclear', original_hash: SHA })) };
    }, /renamed to/],
    ['mirror is_encrypted', () => {
      const r = fullClear();
      return { ...r, payload: new TextEncoder().encode(JSON.stringify({ fcid: 'bafyclear', is_encrypted: true })) };
    }, /dropped in 2\.0\.0/],
    ['mirror duration', () => {
      const r = fullClear();
      return { ...r, payload: new TextEncoder().encode(JSON.stringify({ fcid: 'bafyclear', duration: 1.5 })) };
    }, /dropped in 2\.0\.0/],
    ['mirror gate_type', () => {
      const r = fullClear();
      return { ...r, payload: new TextEncoder().encode(JSON.stringify({ fcid: 'bafyclear', gate_type: 1 })) };
    }, /dropped in 2\.0\.0/],
    ['unknown payload key', () => {
      const r = fullClear();
      return { ...r, payload: new TextEncoder().encode(JSON.stringify({ fcid: 'bafyclear', frobnicate: 1 })) };
    }, /not in the .* record/],
    ['generic without name', () => {
      const r = genericImage();
      return { ...r, payload: new TextEncoder().encode(JSON.stringify({ piece: 'bafkzcibimg', gate: JSON.stringify(gateV1()) })) };
    }, /name is required/],
    ['name on video', () => {
      const r = fullV1();
      const payload = { ...JSON.parse(new TextDecoder().decode(r.payload)), name: 'x.mp4' };
      return { ...r, payload: new TextEncoder().encode(JSON.stringify(payload)) };
    }, /generic-file only/],
    ['ct on video', () => {
      const r = fullV1();
      const payload = { ...JSON.parse(new TextDecoder().decode(r.payload)), ct: 'video/mp4' };
      return { ...r, payload: new TextEncoder().encode(JSON.stringify(payload)) };
    }, /generic-file only/],
    ['ct with mime', () => {
      const r = genericCtFile();
      const payload = { ...JSON.parse(new TextDecoder().decode(r.payload)) };
      return { ...r, payload: new TextEncoder().encode(JSON.stringify(payload)), attributes: { ...r.attributes, mime: 14 } };
    }, /exclusive/],
    ['ct not a MIME', () => {
      const r = genericCtFile();
      const payload = { ...JSON.parse(new TextDecoder().decode(r.payload)), ct: 'blah' };
      return { ...r, payload: new TextEncoder().encode(JSON.stringify(payload)) };
    }, /MIME string/],
    ['bad pt_hash', () => {
      const r = fullV1();
      const payload = { ...JSON.parse(new TextDecoder().decode(r.payload)), pt_hash: 'zz' };
      return { ...r, payload: new TextEncoder().encode(JSON.stringify(payload)) };
    }, /pt_hash/],
    ['bad seg', () => {
      const r = fullV1();
      const payload = { ...JSON.parse(new TextDecoder().decode(r.payload)), seg: { segment_index: 'zero' } };
      return { ...r, payload: new TextEncoder().encode(JSON.stringify(payload)) };
    }, /segment_index/],
    ['bad codecs', () => {
      const r = fullV1();
      const payload = { ...JSON.parse(new TextDecoder().decode(r.payload)), codecs: 'h264' };
      return { ...r, payload: new TextEncoder().encode(JSON.stringify(payload)) };
    }, /array of strings/],
    ['bad attn', () => {
      const r = fullV1();
      const payload = { ...JSON.parse(new TextDecoder().decode(r.payload)), attn: 'sig' };
      return { ...r, payload: new TextEncoder().encode(JSON.stringify(payload)) };
    }, /attn must be an object/],
    ['oversized x', () => {
      const r = fullV1();
      const payload = { ...JSON.parse(new TextDecoder().decode(r.payload)), x: { blob: 'y'.repeat(3000) } };
      return { ...r, payload: new TextEncoder().encode(JSON.stringify(payload)) };
    }, /over the 2048-byte limit/],
    ['oversized payload', () => {
      const r = fullClear();
      return { ...r, payload: new TextEncoder().encode(JSON.stringify({ fcid: 'bafyclear', src: `https://x/${'y'.repeat(140 * 1024)}` })) };
    }, /over the 131072-byte/],
    ['bad size', () => {
      const r = fullClear();
      return { ...r, payload: new TextEncoder().encode(JSON.stringify({ fcid: 'bafyclear', size: -1 })) };
    }, /non-negative integer/],
    ['expiresIn zero', () => ({ ...fullV1(), expiresIn: 0 }), /positive integer/],
    ['expiresIn fractional', () => ({ ...fullV1(), expiresIn: 1.5 }), /positive integer/],
    ['expiresIn odd seconds', () => ({ ...fullV1(), expiresIn: 3601 }), /multiple of the 2s block time/],
    ['series target count', () => {
      const r = dripSeries();
      return { ...r, payload: new TextEncoder().encode(JSON.stringify({ targets: [100] })) };
    }, /!= targets.length/],
    ['series empty targets', () => {
      const r = dripSeries();
      return { ...r, payload: new TextEncoder().encode(JSON.stringify({ targets: [] })) };
    }, /non-empty array/],
    ['series bad target', () => {
      const r = dripSeries();
      return { ...r, payload: new TextEncoder().encode(JSON.stringify({ targets: [100, -5, 1000] })) };
    }, /non-negative integer/],
    ['series with sha256_ct', () => { const r = dripSeries(); return { ...r, attributes: { ...r.attributes, sha256_ct: SHA } }; }, /not in the .* drip series/],
    ['series payload with piece', () => {
      const r = dripSeries();
      return { ...r, payload: new TextEncoder().encode(JSON.stringify({ targets: [100, 500, 1000], piece: 'bafk' })) };
    }, /series payload is/],
    ['series gate_type 3', () => { const r = dripSeries(); return { ...r, attributes: { ...r.attributes, gate_type: 3 } }; }, /must be 4/],
    ['series drip_total 0', () => { const r = dripSeries(); return { ...r, attributes: { ...r.attributes, drip_total: 0 } }; }, />= 1/],
    ['part without series_ref', () => { const r = dripPart(); const { series_ref: _d, ...rest } = r.attributes; return { ...r, attributes: rest }; }, /series_ref/],
    ['part short series_ref', () => { const r = dripPart(); return { ...r, attributes: { ...r.attributes, series_ref: '0x123' } }; }, /32-byte entity key/],
    ['part with title', () => { const r = dripPart(); return { ...r, attributes: { ...r.attributes, title: 'x' } }; }, /join the series/],
    ['part with gate_token', () => { const r = dripPart(); return { ...r, attributes: { ...r.attributes, gate_token: TOKEN } }; }, /lives on the series/],
    ['part payload extra', () => {
      const r = dripPart();
      return { ...r, payload: new TextEncoder().encode(JSON.stringify({ piece: 'bafkzcibpart', gate: JSON.stringify(gateV4()), size: 1 })) };
    }, /exactly \{ piece, gate \}/],
    ['part without piece', () => {
      const r = dripPart();
      return { ...r, payload: new TextEncoder().encode(JSON.stringify({ gate: JSON.stringify(gateV4()) })) };
    }, /piece must be/],
    ['part v3 gate', () => {
      const r = dripPart();
      return { ...r, payload: new TextEncoder().encode(JSON.stringify({ piece: 'bafkzcibpart', gate: JSON.stringify(gateV3()) })) };
    }, /must be 4/],
    ['part negative drip_idx', () => { const r = dripPart(); return { ...r, attributes: { ...r.attributes, drip_idx: -1 } }; }, />= 0/],
    ['part negative mcap', () => { const r = dripPart(); return { ...r, attributes: { ...r.attributes, mcap_usd: -1 } }; }, />= 0/],
  ];

  it.each(cases)('%s', (_name, build, pattern) => {
    expect(() => validateHavenWrite(build() as never)).toThrow(pattern);
  });
});

describe('haven query filters', () => {
  it('lowercases hex and passes the reference wire through', () => {
    expect(normalizeHavenWhere({ grp: 'haven.video.full', gate_token: TOKEN.toUpperCase().replace('0X', '0x') }))
      .toEqual({ grp: 'haven.video.full', gate_token: TOKEN });
    expect(normalizeHavenWhere({ sha256_ct: `0x${SHA.toUpperCase()}` })).toEqual({ sha256_ct: SHA });
  });

  it('wraps series_ref as key and drip-part sha256_ct as bytes32', () => {
    expect(normalizeHavenWhere({ series_ref: SERIES_REF }).series_ref).toEqual({ type: 'key', value: SERIES_REF });
    const scoped = normalizeHavenWhere({ grp: 'haven.video.drip.part', sha256_ct: SHA });
    expect(scoped.sha256_ct).toEqual({ type: 'bytes32', value: `0x${SHA}` });
  });

  it('leaves already-tagged values untouched', () => {
    const tagged = { type: 'key', value: SERIES_REF };
    expect(normalizeHavenWhere({ series_ref: tagged }).series_ref).toBe(tagged);
  });

  it('rejects str-typed numeric filters (they would silently miss)', () => {
    expect(() => normalizeHavenWhere({ gate_type: '4' })).toThrow(/must be a number/);
  });

  it('allows system attributes and rejects reserved names', () => {
    expect(normalizeHavenWhere({ $key: SERIES_REF })).toEqual({ $key: SERIES_REF });
    expect(() => normalizeHavenWhere({ and: 1 })).toThrow(/reserved/);
  });
});

describe('haven runtime wiring', () => {
  function wiredRuntime() {
    const ctx: any = { emit: vi.fn(), reflect: { get: () => undefined } };
    const rt = new ArkivRuntime(ctx as never, 'agent', { privateKeyRef: 'X', rpcUrl: 'https://rpc.tiramisu.test' });
    const seen: Array<{ attributes?: Record<string, unknown>; expiresIn?: number }> = [];
    let creates = 0;
    (rt as any).backend = {
      createEntity: async (params: any) => {
        creates += 1;
        seen.push({ attributes: params.attributes, expiresIn: params.expiresIn });
        return { key: '0x1', txHash: '0x2' };
      },
      updateEntity: async () => ({ txHash: '0x3' }),
      queryEntities: async () => [],
    };
    return { rt, seen, creates: () => creates };
  }

  it('invalid records throw before the backend is touched', async () => {
    const { rt, creates } = wiredRuntime();
    const record = fullV1();
    await expect(rt.createEntity({
      payload: record.payload,
      contentType: record.contentType,
      attributes: { ...record.attributes, gate_type: '1' },
    })).rejects.toThrow(/i32 number/);
    expect(creates()).toBe(0);
  });

  it('the backend receives normalized attributes and the BTL default', async () => {
    const { rt, seen } = wiredRuntime();
    const record = fullV1();
    record.attributes.gate_token = TOKEN.toUpperCase().replace('0X', '0x');
    await rt.createEntity({ payload: record.payload, contentType: record.contentType, attributes: record.attributes });
    expect(seen[0]?.attributes?.gate_token).toBe(TOKEN);
    expect(seen[0]?.expiresIn).toBe(HAVEN_BTL_FULL_S);
  });

  it('differently-cased retries hit the same ledger entry', async () => {
    const { rt, creates } = wiredRuntime();
    const a = fullV1();
    const b = fullV1();
    b.attributes.sha256_ct = `0x${SHA.toUpperCase()}`;
    await rt.createEntity({ payload: a.payload, contentType: a.contentType, attributes: a.attributes });
    await rt.createEntity({ payload: b.payload, contentType: b.contentType, attributes: b.attributes });
    expect(creates()).toBe(1);
  });

  it('updates validate exactly like creates', async () => {
    const { rt } = wiredRuntime();
    const record = fullV1();
    await expect(rt.updateEntity({
      key: '0x1',
      payload: record.payload,
      contentType: record.contentType,
      attributes: { grp: 'haven.video.full' },
    })).rejects.toThrow();
  });

  it('invalid repeats report unknown from the read-back hooks', async () => {
    const { rt } = wiredRuntime();
    await expect(rt.checkCreate({ payload: 'nope', contentType: 'application/json' })).resolves.toEqual({ kind: 'unknown' });
    await expect(rt.checkUpdate({ key: '0x1', payload: 'nope', contentType: 'application/json' })).resolves.toEqual({ kind: 'unknown' });
  });
});

describe('backend result mapping', () => {
  it('reads the SDK entityKey field (never key)', async () => {
    const sdkResult: CreateEntityReturnType = {
      entityKey: '0xabc',
      txHash: '0xdef',
      expiresAt: 100n,
    } as CreateEntityReturnType;
    const seen: unknown[] = [];
    const out = await createEntityWithClient(
      { createEntity: async (data: unknown) => { seen.push(data); return sdkResult; } },
      { payload: new Uint8Array([1]), contentType: 'application/json', attributes: { grp: 'haven.video.full' }, expiresIn: 60 },
    );
    expect(out).toEqual({ key: '0xabc', txHash: '0xdef' });
    expect(seen).toHaveLength(1);
  });
});
