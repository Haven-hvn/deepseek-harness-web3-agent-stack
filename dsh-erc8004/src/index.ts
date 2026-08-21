/**
 * ERC-8004 Identity Registry for DSH — ctx.erc8004 + erc8004_* tools.
 *
 * Two-plane port of the Filecoin Pin + ERC-8004 tutorial (docs.filecoin.io):
 * - Filecoin Pin: agent card JSON → IPFS CID (PDP proofs) via ctx.synapse (dsh-storage-synapse, USDFC)
 * - ERC-8004: register(string tokenURI) on Base Sepolia 0x8004A818BFB912233c491871b3d84c89A494BD9e via wallet-gated signing
 *
 * Isolated bundle, coupled at seams:
 * - Injects wallet (signer identity) + tools + optional treasury/synapse/credentials — never stores a raw key.
 * - Filecoin: delegated entirely to ctx.synapse (its own per-operation gated credential) — no privateKey in this package.
 * - Base Sepolia: viem publicClient + custom toAccount delegating signTransaction/signMessage to ctx.wallet (OWS vault), treasury authorize/recordExpense.
 *
 * @module dsh-erc8004
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { buildDefaultCard, Erc8004Backend, ERC8004_ABI, type AgentCard } from './erc8004.ts'
import type { Erc8004CardStoredEvent, Erc8004RegisteredEvent } from './types.ts'

export type { AgentCard } from './erc8004.ts'
export type { Erc8004CardStoredEvent, Erc8004RegisteredEvent } from './types.ts'

export const name = 'erc8004'
export const inject = ['wallet', 'tools'] as const

export interface Config {
  wallet: string
  baseRpcUrl: string
  identityRegistry: string
  chainId: number
  agentName?: string | undefined
  agentDescription?: string | undefined
  mcpEndpoint?: string | undefined
  image?: string | undefined
}

export const Config = z.object({
  wallet: z.string().required(),
  baseRpcUrl: z.string().default('https://sepolia.base.org'),
  identityRegistry: z.string().default('0x8004A818BFB912233c491871b3d84c89A494BD9e'),
  chainId: z.number().default(84532),
  agentName: z.string().default('DeepSeek Harness Agent'),
  image: z.string().default('https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png'),
  agentDescription: z.string().default('Autonomous agent on DeepSeek Harness (dsh-channel-xmtp + dsh-wallet + dsh-erc8004). Provides XMTP messaging, wallet tools, Filecoin Pin storage, and ERC-8004 verifiable identity.'),
  mcpEndpoint: z.string().default('https://api.githubcopilot.com/mcp/'),
})

export class Erc8004Runtime {
  private backend: Erc8004Backend | null = null
  private readonly _baseRpcUrl: string
  private readonly _identityRegistry: `0x${string}`
  private readonly _chainId: number
  private readonly _agentName: string | undefined
  private readonly _agentDescription: string | undefined
  private readonly _mcpEndpoint: string | undefined
  private readonly _image: string | undefined

  constructor(
    private readonly ctx: Context,
    private readonly wallet: string,
    opts: {
      baseRpcUrl: string
      identityRegistry: `0x${string}`
      chainId: number
      agentName?: string | undefined
      agentDescription?: string | undefined
      mcpEndpoint?: string | undefined
      image?: string | undefined
    },
  ) {
    if (!opts.baseRpcUrl) throw new Error('dsh-erc8004: baseRpcUrl required')
    this._baseRpcUrl = opts.baseRpcUrl
    this._identityRegistry = opts.identityRegistry
    this._chainId = opts.chainId
    this._agentName = opts.agentName
    this._agentDescription = opts.agentDescription
    this._mcpEndpoint = opts.mcpEndpoint
    this._image = opts.image
  }

  private async ensureBackend(): Promise<Erc8004Backend> {
    if (this.backend) return this.backend
    this.backend = new Erc8004Backend({
      baseRpcUrl: this._baseRpcUrl,
      identityRegistry: this._identityRegistry,
      chainId: this._chainId,
    })
    return this.backend
  }

  /** Build a spec-compliant agent card for the given owner address. */
  buildCard(ownerAddress: string, overrides?: Partial<AgentCard>): AgentCard {
    const base = buildDefaultCard({
      ownerAddress,
      ...(this._agentName !== undefined ? { name: this._agentName } : {}),
      ...(this._agentDescription !== undefined ? { description: this._agentDescription } : {}),
      ...(this._image !== undefined ? { image: this._image } : {}),
      ...(this._mcpEndpoint !== undefined ? { mcpEndpoint: this._mcpEndpoint } : {}),
      chainId: this._chainId,
    })
    if (!overrides) return base
    return { ...base, ...overrides, endpoints: (overrides.endpoints as any) ?? base.endpoints }
  }

  /** Store card JSON on Filecoin via ctx.synapse and return CID + ipfs:// tokenURI. Emits erc8004/card-stored. */
  async storeCard(card: AgentCard, filename = 'agent-card.json'): Promise<{ cid: string; tokenUri: string; pieceCid?: string | undefined }> {
    const synapse: any = (this.ctx as any).synapse
    if (!synapse?.store) {
      throw new Error('dsh-erc8004: ctx.synapse not mounted — install dsh-storage-synapse for Filecoin Pin (PDP proofs). Card built but not pinned.')
    }
    const data = new TextEncoder().encode(JSON.stringify(card, null, 2))
    const { cid, pieceCid } = await synapse.store(data)
    const tokenUri = `ipfs://${cid}/${filename}`
    this.ctx.emit('erc8004/card-stored', { cid, tokenUri } satisfies Erc8004CardStoredEvent)
    return { cid, tokenUri, pieceCid }
  }

  /** Register tokenURI on the ERC-8004 Identity Registry via wallet-gated signing. Emits erc8004/registered. */
  async register(tokenUri: string): Promise<{ agentId: string; txHash: `0x${string}`; tokenUri: string }> {
    const walletSeam: any = (this.ctx as any).wallet
    const treasury: any = (() => {
      try { return (this.ctx as any).get?.('treasury') } catch {}
      try { return (this.ctx as any).treasury } catch { return undefined }
    })()
    if (!walletSeam?.address || typeof walletSeam.signTransaction !== 'function') {
      throw new Error('dsh-erc8004: ctx.wallet not mounted or missing signTransaction')
    }
    const owner: string = await walletSeam.address(this.wallet)

    // Treasury pre-check (if mounted) — authorize estimated gas cost, fail fast on DEPLETED
    const ESTIMATED_GAS_COST_USDC = 2_000 // ~$0.002 per register; treasury is µUSD, so 2000
    if (treasury?.authorize) {
      try {
        const decision = treasury.authorize('storage', ESTIMATED_GAS_COST_USDC)
        if (decision && decision.authorized === false) {
          throw new Error(`treasury blocked register: ${decision.reason ?? decision.code ?? 'insufficient funds'}`)
        }
      } catch (e) {
        if ((e as Error).message.includes('treasury blocked')) throw e
        // Non-fatal: treasury read should not block registration if it throws for other reasons
      }
    }

    const be = await this.ensureBackend()
    const publicClient: any = await be.getPublicClient()
    const { encodeFunctionData, serializeTransaction } = await import('viem')

    const data = encodeFunctionData({
      abi: ERC8004_ABI,
      functionName: 'register',
      args: [tokenUri],
    })

    // Prepare transaction request (nonce, gas, etc.) via publicClient
    const nonce = await publicClient.getTransactionCount({ address: owner as `0x${string}` })
    const gas = await publicClient.estimateGas({ account: owner as `0x${string}`, to: this._identityRegistry, data }).catch(() => 200_000n)
    let gasPrice: bigint | undefined
    try {
      gasPrice = await publicClient.getGasPrice()
    } catch { gasPrice = undefined }

    const tx: any = {
      to: this._identityRegistry as `0x${string}`,
      data,
      nonce,
      gas,
      ...(gasPrice !== undefined ? { gasPrice } : {}),
      chainId: this._chainId,
      type: 'legacy' as const,
    }

    const serializedUnsigned = serializeTransaction(tx as any)
    const { signature: signedRaw } = await walletSeam.signTransaction(this.wallet, serializedUnsigned)
    // wallet returns signed transaction hex (OWS sign-only) — send via publicClient
    const hash: `0x${string}` = await publicClient.sendRawTransaction({ serializedTransaction: signedRaw as `0x${string}` })

    const receipt: any = await publicClient.waitForTransactionReceipt({ hash })
    let agentId = '0'
    try {
      const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
      const log: any = receipt.logs?.find((l: any) => l.topics?.[0]?.toLowerCase() === transferTopic)
      if (log?.topics?.[3]) {
        agentId = BigInt(log.topics[3] as string).toString(10)
      }
    } catch {}

    // Treasury post-commit: record expense if mounted (best-effort)
    if (treasury?.recordExpense || treasury?.addExpense) {
      try {
        const record = treasury.recordExpense ?? treasury.addExpense
        await record.call(treasury, { category: 'storage', amountUsd: ESTIMATED_GAS_COST_USDC / 1_000_000, description: `erc8004 register ${tokenUri}` })
      } catch {}
    } else if (treasury?.emit) {
      // Fallback: at least emit for policy visibility
      try { treasury.emit?.('expense', { category: 'storage', amount: ESTIMATED_GAS_COST_USDC }) } catch {}
    }

    this.ctx.emit('erc8004/registered', { agentId, tokenUri, txHash: hash, owner } satisfies Erc8004RegisteredEvent)
    return { agentId, txHash: hash, tokenUri }
  }

  /** Full flow: build card → store on Filecoin (via synapse) → register on Base Sepolia (via wallet). */
  async registerAgent(overrides?: Partial<AgentCard> & { filename?: string | undefined }): Promise<{ card: AgentCard; cid: string; tokenUri: string; agentId: string; txHash: `0x${string}`; pieceCid?: string | undefined }> {
    const walletSeam: any = (this.ctx as any).wallet
    if (!walletSeam?.address) throw new Error('dsh-erc8004: ctx.wallet not mounted')
    const owner = await walletSeam.address(this.wallet)
    const card = this.buildCard(owner, overrides)
    const filename = overrides?.filename ?? 'agent-card.json'
    const { cid, tokenUri, pieceCid } = await this.storeCard(card, filename)
    const { agentId, txHash } = await this.register(tokenUri)
    return { card, cid, tokenUri, agentId, txHash, pieceCid }
  }

  async tokenURI(agentId: string | bigint): Promise<string> {
    const be = await this.ensureBackend()
    return be.tokenURI(agentId)
  }

  async ownerOf(agentId: string | bigint): Promise<string> {
    const be = await this.ensureBackend()
    return be.ownerOf(agentId)
  }

  get config() {
    return {
      wallet: this.wallet,
      baseRpcUrl: this._baseRpcUrl,
      identityRegistry: this._identityRegistry,
      chainId: this._chainId,
    }
  }
}

const REGISTER_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agentId: { type: 'string', required: true, description: 'ERC-721 tokenId (decimal string)' },
    tokenUri: { type: 'string', required: true, description: 'ipfs://<cid>/agent-card.json' },
    txHash: { type: 'string', required: true, description: 'Base Sepolia registration tx hash' },
    cid: { type: 'string', required: true },
    pieceCid: { type: 'string', description: 'Filecoin piece CID when available' },
  },
} as const

const CARD_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    type: { type: 'string', required: true },
    name: { type: 'string', required: true },
    description: { type: 'string', required: true },
    image: { type: 'string' },
    endpoints: { type: 'array' },
    registrations: { type: 'array' },
    supportedTrust: { type: 'array' },
  },
} as const

export function apply(ctx: Context, config: Config): void {
  const runtime = new Erc8004Runtime(ctx, config.wallet, {
    baseRpcUrl: config.baseRpcUrl,
    identityRegistry: config.identityRegistry as `0x${string}`,
    chainId: config.chainId,
    ...(config.agentName !== undefined ? { agentName: config.agentName } : {}),
    ...(config.agentDescription !== undefined ? { agentDescription: config.agentDescription } : {}),
    ...(config.mcpEndpoint !== undefined ? { mcpEndpoint: config.mcpEndpoint } : {}),
    ...(config.image !== undefined ? { image: config.image } : {}),
  } as any)
  ctx.provide('erc8004', runtime)

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'erc8004_build_card',
        description:
          'Build an ERC-8004 registration-v1 agent card (type/name/description/endpoints/supportedTrust) for the agent wallet. Returns the card JSON. The agentWallet endpoint is eip155:chainId:address derived live via ctx.wallet.',
        parameters: {
          name: { type: 'string', description: 'Agent name override (default from config agentName)' },
          description: { type: 'string', description: 'Agent description override' },
          mcpEndpoint: { type: 'string', description: 'MCP endpoint URL override' },
          image: { type: 'string', description: 'Avatar/logo URL override' },
        },
        output: { schema: CARD_SCHEMA as any, render: (_a: unknown, v: unknown) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
        async execute(args: { name?: string | undefined; description?: string | undefined; mcpEndpoint?: string | undefined; image?: string | undefined }): Promise<any> {
          const walletSeam: any = (ctx as any).wallet
          const owner = await walletSeam.address(config.wallet)
          return runtime.buildCard(owner, {
            ...(args.name !== undefined ? { name: args.name } : {}),
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(args.image !== undefined ? { image: args.image } : {}),
            ...(args.mcpEndpoint !== undefined ? { endpoints: [
              { name: 'MCP', endpoint: args.mcpEndpoint, version: '1.0.0', capabilities: { tools: [{ name: 'xmtp', description: 'XMTP messaging' }] } },
              { name: 'agentWallet', endpoint: `eip155:${config.chainId}:${owner}` },
            ] } : {}),
          } as any)
        },
        presentCall: () => ({ card: 'generic', title: 'Build ERC-8004 agent card', kind: 'read' }),
      }),
    ),
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'erc8004_register',
        description:
          'Register the agent on the ERC-8004 Identity Registry (Base Sepolia 0x8004...BD9e): build card → pin to Filecoin via ctx.synapse (PDP proofs) → register(string tokenURI) via ctx.wallet signTransaction + treasury (sign-only, ~0.001 ETH gas). Provide custom tokenUri to skip build+pin and register directly. Returns agentId (tokenId), tokenUri ipfs://<cid>/agent-card.json, txHash, and Filecoin CIDs.',
        parameters: {
          tokenUri: { type: 'string', description: 'Existing ipfs://<cid>/agent-card.json to register directly (skips build+pin)' },
          name: { type: 'string', description: 'Agent name override for the built card' },
          description: { type: 'string', description: 'Agent description override' },
          mcpEndpoint: { type: 'string', description: 'MCP endpoint override' },
          filename: { type: 'string', description: 'Card filename for tokenUri (default agent-card.json)' },
        },
        output: { schema: REGISTER_RESULT_SCHEMA, render: (_a: unknown, v: unknown) => [{ type: 'text', text: `Agent ${(v as any).agentId} registered: ${(v as any).tokenUri} tx ${(v as any).txHash} (CID ${(v as any).cid})` }] },
        async execute(args: { tokenUri?: string | undefined; name?: string | undefined; description?: string | undefined; mcpEndpoint?: string | undefined; filename?: string | undefined }): Promise<any> {
          if (args.tokenUri !== undefined) {
            const { agentId, txHash } = await runtime.register(args.tokenUri)
            const cid = args.tokenUri.replace('ipfs://', '').split('/')[0] ?? ''
            return { agentId, tokenUri: args.tokenUri, txHash, cid }
          }
          const overrides: any = {}
          if (args.name !== undefined) overrides.name = args.name
          if (args.description !== undefined) overrides.description = args.description
          if (args.mcpEndpoint !== undefined) overrides.mcpEndpoint = args.mcpEndpoint
          if (args.filename !== undefined) overrides.filename = args.filename
          const res = await runtime.registerAgent(overrides)
          return { agentId: res.agentId, tokenUri: res.tokenUri, txHash: res.txHash, cid: res.cid, ...(res.pieceCid !== undefined ? { pieceCid: res.pieceCid } : {}) }
        },
        presentCall: args => ({ card: 'generic', title: args.tokenUri ? `Register ERC-8004 ${args.tokenUri}` : 'Register ERC-8004 agent (Filecoin Pin + Base Sepolia)', kind: 'execute' }),
      }),
    ),
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'erc8004_token_uri',
        description: 'Read the ERC-8004 tokenURI for an agentId (tokenId) via Base Sepolia call tokenURI(uint256). Verifies on-chain registration.',
        parameters: {
          agentId: { type: 'string', required: true, description: 'Agent tokenId decimal string (from erc8004_register)' },
        },
        output: { schema: { type: 'string' }, render(_a: unknown, v: string) { return [{ type: 'text', text: v }] as never } },
        async execute(args: { agentId: string }): Promise<string> {
          return runtime.tokenURI(args.agentId)
        },
        presentCall: args => ({ card: 'generic', title: `ERC-8004 tokenURI #${args.agentId}`, kind: 'read' }),
      }),
    ),
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'erc8004_owner_of',
        description: 'Read ownerOf for an ERC-8004 agentId on Base Sepolia.',
        parameters: {
          agentId: { type: 'string', required: true, description: 'Agent tokenId decimal string' },
        },
        output: { schema: { type: 'string' }, render(_a: unknown, v: string) { return [{ type: 'text', text: v }] as never } },
        async execute(args: { agentId: string }): Promise<string> {
          return runtime.ownerOf(args.agentId)
        },
        presentCall: args => ({ card: 'generic', title: `ERC-8004 ownerOf #${args.agentId}`, kind: 'read' }),
      }),
    ),
  )
}
