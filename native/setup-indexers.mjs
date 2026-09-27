#!/usr/bin/env node
/**
 * setup-indexers.mjs — idempotently add the proven public indexers to the
 * in-container Prowlarr. Polls for readiness, skips indexers already added.
 * Non-fatal by contract: logs loudly, exits 0 unless Prowlarr never came up
 * (the container stays alive either way; re-runs every boot).
 *
 * Env: PROWLARR_API_KEY (required).
 */
const BASE = 'http://127.0.0.1:9696/api/v1';
const WANT = ['thepiratebay', 'yts', 'limetorrents', 'nyaasi', 'rutor'];
const READY_BUDGET_MS = 180_000;

const KEY = process.env.PROWLARR_API_KEY;
if (!KEY) {
  console.error('setup-indexers: PROWLARR_API_KEY is not set');
  process.exit(1);
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'X-Api-Key': KEY, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* plain text */ }
  return { status: res.status, json, text: text.slice(0, 300) };
}

async function waitReady() {
  const deadline = Date.now() + READY_BUDGET_MS;
  for (;;) {
    try {
      const { status } = await api('GET', '/system/status');
      if (status === 200) return true;
      if (status === 401) {
        console.error('setup-indexers: API key rejected (401) — refusing to continue');
        return false;
      }
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

const ready = await waitReady();
if (!ready) {
  console.error('setup-indexers: Prowlarr never became ready; indexers left unconfigured');
  process.exit(1);
}

const schemas = await api('GET', '/indexer/schema');
if (schemas.status !== 200 || !Array.isArray(schemas.json)) {
  console.error(`setup-indexers: cannot list schemas (HTTP ${schemas.status})`);
  process.exit(1);
}
const byName = new Map(schemas.json.map((s) => [s.definitionName, s]));
const existing = await api('GET', '/indexer');
const have = new Set(Array.isArray(existing.json) ? existing.json.map((i) => i.definitionName) : []);

for (const name of WANT) {
  if (have.has(name)) {
    console.log(`setup-indexers: SKIP ${name} (already added)`);
    continue;
  }
  const schema = byName.get(name);
  if (!schema) {
    console.log(`setup-indexers: MISS ${name} (no such definition in this Prowlarr)`);
    continue;
  }
  const payload = { ...schema };
  delete payload.presets;
  delete payload.sortName;
  delete payload.added;
  payload.name = name;
  payload.enable = true;
  payload.priority = 25;
  payload.appProfileId = 1;
  const res = await api('POST', '/indexer', payload);
  if (res.status === 200 || res.status === 201) {
    console.log(`setup-indexers: OK ${name} (id=${res.json?.id})`);
  } else {
    console.log(`setup-indexers: FAIL ${name} (HTTP ${res.status}: ${res.text})`);
  }
}
console.log('setup-indexers: done');
