/**
 * Type surface of the ERC-8004 capability seam: ctx.erc8004 and audit events.
 */

import type { Erc8004Runtime } from './index.ts'

export interface Erc8004RegisteredEvent {
  readonly agentId: string
  readonly tokenUri: string
  readonly txHash: `0x${string}`
  readonly owner: string
}

export interface Erc8004CardStoredEvent {
  readonly cid: string
  readonly tokenUri: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    erc8004: Erc8004Runtime
  }

  interface Events {
    /**
     * Agent card stored on Filecoin (Synapse/filecoin-pin) before on-chain registration.
     * @param event - CID and tokenURI of the pinned card.
     * @mode emit
     */
    'erc8004/card-stored'(event: Erc8004CardStoredEvent): void
    /**
     * ERC-8004 Identity Registry register(string) committed — agent NFT minted.
     * @param event - agentId (tokenId), tokenURI, txHash, owner.
     * @mode emit
     */
    'erc8004/registered'(event: Erc8004RegisteredEvent): void
  }
}
