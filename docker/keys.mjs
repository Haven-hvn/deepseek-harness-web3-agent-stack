#!/usr/bin/env node
/**
 * keys.mjs — first-boot key instantiation for the agent container.
 *
 * Generates the two hot, agent-managed wallets and derives their public
 * identities. Everything secret stays in <outdir> (mode 0600); the script
 * prints ONLY public material (addresses, principal, inbox id) as JSON.
 *
 * Output files:
 *   evm.key          0x-prefixed secp256k1 private key (0600)
 *   evm.address      checksummed EVM address (0644)
 *   icp.pem          ed25519 private key, PKCS#8 PEM (0600)
 *   icp.seed         ed25519 seed hex, 32 bytes (0600)
 *   icp.principal    self-authenticating principal text (0644)
 *   inbox.id         XMTP v3 inbox id derived from the EVM address (0644)
 *
 * Usage: node keys.mjs <outdir>
 * Requires: viem, @xmtp/node-sdk (installed globally in the image).
 */

import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** IEEE CRC32 of buf as unsigned int. */
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, no padding. */
function base32Encode(buf) {
  let out = '';
  let bits = 0;
  let width = 0;
  for (const byte of buf) {
    bits = (bits << 8) | byte;
    width += 8;
    while (width >= 5) {
      width -= 5;
      out += B32[(bits >>> width) & 31];
    }
  }
  if (width > 0) out += B32[(bits << (5 - width)) & 31];
  return out;
}

/**
 * Self-authenticating ICP principal text for an ed25519 SPKI DER public key:
 * crc32(sha224(der) || 0x02) prepended, base32, lowercase, dashed per 5 chars.
 */
export function principalFromDerPubkey(der) {
  const digest = createHash('sha224').update(der).digest();
  const bytes = Buffer.concat([digest, Buffer.from([0x02])]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(bytes));
  return base32Encode(Buffer.concat([checksum, bytes])).toLowerCase().replace(/(.{5})(?=.)/g, '$1-');
}

function writeSecret(path, data) {
  writeFileSync(path, data, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function writePublic(path, data) {
  writeFileSync(path, data, { mode: 0o644 });
}

async function main() {
  const outdir = process.argv[2];
  if (!outdir) {
    console.error('usage: node keys.mjs <outdir>');
    process.exit(2);
  }
  mkdirSync(outdir, { recursive: true, mode: 0o700 });
  try { chmodSync(outdir, 0o700); } catch { /* best effort on odd filesystems */ }

  // ── EVM (secp256k1) ──────────────────────────────────────────────
  const evmKey = generatePrivateKey();
  const evmAddress = privateKeyToAccount(evmKey).address;
  if (!/^0x[0-9a-fA-F]{40}$/.test(evmAddress)) throw new Error('derived invalid EVM address');
  writeSecret(join(outdir, 'evm.key'), `${evmKey}\n`);
  writePublic(join(outdir, 'evm.address'), `${evmAddress}\n`);

  // ── ICP (ed25519) ────────────────────────────────────────────────
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const pkcs8Pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const seedHex = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url').toString('hex');
  const principal = principalFromDerPubkey(spkiDer);
  if (!/^[a-z0-9-]+$/.test(principal) || !principal.includes('-')) throw new Error('derived invalid ICP principal');
  writeSecret(join(outdir, 'icp.pem'), pkcs8Pem);
  writeSecret(join(outdir, 'icp.seed'), `${seedHex}\n`);
  writePublic(join(outdir, 'icp.principal'), `${principal}\n`);

  // ── XMTP inbox id (offline derivation from the EVM address) ───────
  const { generateInboxId, IdentifierKind } = await import('@xmtp/node-sdk');
  const inboxId = generateInboxId({ identifier: evmAddress.toLowerCase(), identifierKind: IdentifierKind.Ethereum });
  if (!/^[0-9a-f]{64}$/.test(inboxId)) throw new Error(`derived invalid inbox id: ${String(inboxId).slice(0, 32)}`);
  writePublic(join(outdir, 'inbox.id'), `${inboxId}\n`);

  // Refuse to run twice into a populated dir (never silently rotate keys).
  // (Checked implicitly: callers test existence first; kept documented here.)

  console.log(JSON.stringify({ evmAddress, icpPrincipal: principal, inboxId }));
}

const invokedAsMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsMain) {
  await main();
}
