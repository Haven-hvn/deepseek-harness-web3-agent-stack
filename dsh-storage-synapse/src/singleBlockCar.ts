/**
 * Single-block CAR packing for every store.
 *
 * Port of haven-cli `js-services/single-block-car.ts` (`packSingleBlockCar`
 * byte-for-byte: CARv1 header with tag-42 + multibase-identity-prefixed
 * root, one raw-codec frame). One deliberate deviation: haven-cli packs
 * single-block only at or under 32 MiB and chunked-UnixFS above. The
 * chunked shape cannot play on current readers — the CAR header's
 * tag-42-wrapped dag-pb root fails their root check ("Nested CAR
 * container: only flat raw-leaf pieces are supported") — while the
 * single-block shape strips and decrypts at any size. So every store
 * packs single-block, no threshold. Node-native (sync SHA-256, no Deno).
 *
 * @module dsh-storage-synapse/singleBlockCar
 */

import { createHash } from 'node:crypto'
import { createReadStream, type ReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { CID } from 'multiformats/cid'

/**
 * Default read chunk size (256 KiB) for streaming SHA-256 hashing and
 * disk-backed CAR uploads. Keeps peak heap O(chunkSize) regardless of file size.
 */
export const DEFAULT_STREAM_CHUNK_BYTES = 256 * 1024

/**
 * In-memory Uint8Array payloads above this threshold (4 MiB) are streamed
 * zero-copy via `createSingleBlockCarBytesStream` instead of allocating a
 * second full CAR buffer. File inputs always stream regardless of size.
 */
export const SINGLE_BLOCK_STREAM_THRESHOLD = 4 * 1024 * 1024

export interface FileSha256Result {
  /** Raw 32-byte SHA-256 digest. */
  digest: Uint8Array
  /** Lowercase hex-encoded SHA-256 digest (for dedup ledgers). */
  hex: string
  /** Exact byte length of the hashed file. */
  size: number
}

export interface SingleBlockCarPrefix {
  /** CARv1 prefix bytes: headerLen || headerBody || blockLen || cidBytes (~96–101 B). */
  prefix: Uint8Array
  /** Base32 CIDv1 (raw codec, sha2-256) of the payload. */
  rootCid: string
  /** Exact total CAR byte length (`prefix.length + dataLength`). */
  carByteLength: number
}

/** Unsigned LEB128 (varint) encoding used by CARv1 length prefixes. */
export function encodeVarint(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`dsh-storage-synapse: encodeVarint expects a non-negative safe integer, got ${value}`)
  }
  const out: number[] = []
  let v = value
  do {
    let b = v % 128
    v = Math.floor(v / 128)
    if (v > 0) b |= 0x80
    out.push(b)
  } while (v > 0)
  return new Uint8Array(out)
}

// A2 map(2) | 65 "roots" | 81 array(1) | D8 2A tag(42) | 58 25 bytes(37) |
// 00 multibase-identity | 01 v1 | 55 raw | 12 20 sha2-256 32 B — then digest.
const HEADER_PREFIX = new Uint8Array([
  0xa2, 0x65, 0x72, 0x6f, 0x6f, 0x74, 0x73, 0x81,
  0xd8, 0x2a, 0x58, 0x25, 0x00, 0x01, 0x55, 0x12, 0x20,
])
// 67 "version" | 01.
const HEADER_SUFFIX = new Uint8Array([
  0x67, 0x76, 0x65, 0x72, 0x73, 0x69, 0x6f, 0x6e, 0x01,
])

/**
 * Stream a file through SHA-256 without buffering it in memory.
 * Verifies the streamed byte count matches `stat(filePath).size`.
 */
export async function hashFileSha256(
  filePath: string,
  opts?: { highWaterMark?: number | undefined },
): Promise<FileSha256Result> {
  const info = await stat(filePath)
  const hash = createHash('sha256')
  let size = 0
  const stream = createReadStream(filePath, {
    highWaterMark: opts?.highWaterMark ?? DEFAULT_STREAM_CHUNK_BYTES,
  })
  try {
    for await (const chunk of stream) {
      const buf = chunk as Uint8Array
      hash.update(buf)
      size += buf.byteLength
    }
  } catch (err) {
    if (!stream.destroyed) stream.destroy()
    throw err
  }
  if (size !== info.size) {
    throw new Error(
      `dsh-storage-synapse: file ${filePath} changed size while hashing (stat=${info.size}, read=${size})`,
    )
  }
  const buf = hash.digest()
  return {
    digest: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
    hex: buf.toString('hex'),
    size,
  }
}

/**
 * Build the ~96–101 byte CARv1 prefix (`headerLen || headerBody || blockLen || cidBytes`)
 * and root CID from a precomputed 32-byte SHA-256 digest and payload byte length,
 * without touching or copying the payload bytes.
 */
export function buildSingleBlockCarPrefix(digest: Uint8Array, dataLength: number): SingleBlockCarPrefix {
  if (digest.length !== 32) {
    throw new Error(`dsh-storage-synapse: expected 32-byte sha256 digest, got ${digest.length}`)
  }
  if (!Number.isSafeInteger(dataLength) || dataLength < 0) {
    throw new Error(`dsh-storage-synapse: expected non-negative safe integer dataLength, got ${dataLength}`)
  }
  // CIDv1 bytes: 0x01 (version) 0x55 (raw) 0x12 0x20 (sha2-256, 32 B) + digest.
  const cidBytes = new Uint8Array(4 + digest.length)
  cidBytes.set([0x01, 0x55, 0x12, 0x20], 0)
  cidBytes.set(digest, 4)
  const rootCid = CID.decode(cidBytes).toString()

  // CARv1 header: dag-cbor {roots: [cid], version: 1} (canonical key order:
  // "roots" before "version"). CID is tag 42 + 0x00-prefixed CID bytes.
  const headerBody = new Uint8Array(HEADER_PREFIX.length + digest.length + HEADER_SUFFIX.length)
  headerBody.set(HEADER_PREFIX, 0)
  headerBody.set(digest, HEADER_PREFIX.length)
  headerBody.set(HEADER_SUFFIX, HEADER_PREFIX.length + digest.length)

  const headerLen = encodeVarint(headerBody.length)
  const blockLen = encodeVarint(cidBytes.length + dataLength)
  const prefix = new Uint8Array(
    headerLen.length + headerBody.length + blockLen.length + cidBytes.length,
  )
  let o = 0
  prefix.set(headerLen, o)
  o += headerLen.length
  prefix.set(headerBody, o)
  o += headerBody.length
  prefix.set(blockLen, o)
  o += blockLen.length
  prefix.set(cidBytes, o)

  return {
    prefix,
    rootCid,
    carByteLength: prefix.length + dataLength,
  }
}

/**
 * Create a Web `ReadableStream<Uint8Array>` that emits the single-block CARv1
 * prefix followed by chunks streamed directly from `filePath`.
 *
 * Peak heap is O(highWaterMark) regardless of file size; `createReadStream` is
 * opened lazily after the prefix is pulled and destroyed cleanly on cancel/error.
 */
export function createSingleBlockCarFileStream(
  filePath: string,
  prefix: Uint8Array,
  opts?: { highWaterMark?: number | undefined; expectedDataLength?: number | undefined },
): ReadableStream<Uint8Array> {
  let prefixSent = false
  let dataBytesStreamed = 0
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let nodeStream: ReadStream | null = null

  const cleanup = (reason?: unknown): void => {
    if (reader !== null) {
      const r = reader
      reader = null
      r.cancel(reason).catch(() => {})
      try { r.releaseLock() } catch {}
    }
    if (nodeStream !== null) {
      const s = nodeStream
      nodeStream = null
      if (!s.destroyed) s.destroy()
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!prefixSent) {
        prefixSent = true
        controller.enqueue(prefix)
        return
      }
      if (reader === null) {
        nodeStream = createReadStream(filePath, {
          highWaterMark: opts?.highWaterMark ?? DEFAULT_STREAM_CHUNK_BYTES,
        })
        const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>
        reader = webStream.getReader()
      }
      try {
        const { done, value } = await reader.read()
        if (done) {
          if (opts?.expectedDataLength !== undefined && dataBytesStreamed !== opts.expectedDataLength) {
            const err = new Error(
              `dsh-storage-synapse: file ${filePath} changed size during upload `
              + `(expected ${opts.expectedDataLength} bytes, streamed ${dataBytesStreamed})`,
            )
            cleanup(err)
            controller.error(err)
            return
          }
          cleanup()
          controller.close()
        } else {
          dataBytesStreamed += value.byteLength
          controller.enqueue(value)
        }
      } catch (err) {
        cleanup(err)
        controller.error(err)
      }
    },
    cancel(reason) {
      cleanup(reason)
    },
  })
}

/**
 * Create a zero-copy Web `ReadableStream<Uint8Array>` emitting the single-block
 * CARv1 prefix followed by `subarray` slices of an in-memory `Uint8Array`.
 * Avoids allocating a second full-file CAR buffer when callers pass large buffers.
 */
export function createSingleBlockCarBytesStream(
  data: Uint8Array,
  prefix: Uint8Array,
  chunkSize = DEFAULT_STREAM_CHUNK_BYTES,
): ReadableStream<Uint8Array> {
  let prefixSent = false
  let offset = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!prefixSent) {
        prefixSent = true
        controller.enqueue(prefix)
        return
      }
      if (offset >= data.byteLength) {
        controller.close()
        return
      }
      const end = Math.min(offset + chunkSize, data.byteLength)
      controller.enqueue(data.subarray(offset, end))
      offset = end
    },
  })
}

/**
 * Pack bytes as a single-raw-block CARv1.
 * @returns the CAR bytes plus the root CID string (base32 CIDv1, raw codec, sha2-256).
 */
export function packSingleBlockCar(data: Uint8Array): { carBytes: Uint8Array; rootCid: string } {
  const digest = new Uint8Array(createHash('sha256').update(data).digest())
  const { prefix, rootCid, carByteLength } = buildSingleBlockCarPrefix(digest, data.length)
  const carBytes = new Uint8Array(carByteLength)
  carBytes.set(prefix, 0)
  carBytes.set(data, prefix.length)
  return { carBytes, rootCid }
}
