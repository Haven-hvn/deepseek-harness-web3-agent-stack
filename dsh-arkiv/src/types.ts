/**
 * Arkiv entity types — conformant with arkiv-sdk-js/src/types/entity.ts and haven spec.
 * Haven-core has no Arkiv entity; canonical is arkiv-sdk-js EntityFields.
 * This file re-exports the Arkiv Entity shape for DSH so tool I/O matches haven-cli's arkiv_sync.
 */
export type { EntityFields, Entity } from '@arkiv-network/sdk';
export type ArkivEntityKey = `0x${string}`;
export type ArkivAttributeValue = unknown;

export interface ArkivCreateParams {
  payload: Uint8Array;
  contentType: string;
  attributes?: Record<string, unknown>;
  expiresIn?: number; // seconds, like haven_cli ArkivSyncConfig.expires_in
}

export interface ArkivEntityRecord {
  key: `0x${string}`;
  owner: `0x${string}`;
  payload?: Uint8Array;
  contentType?: string;
  attributes?: Record<string, unknown>;
  expiresAt?: bigint;
  txHash?: `0x${string}`;
}
