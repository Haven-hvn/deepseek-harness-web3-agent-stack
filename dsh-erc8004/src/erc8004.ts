/**
 * ERC-8004 transport — viem over Base Sepolia + Filecoin Pin via ctx.synapse.
 *
 * Two planes, both gated through DSH seams (no raw key in this package):
 * 1) Filecoin Pin: delegated to ctx.synapse (dsh-storage-synapse) — PDP proofs, USDFC via its own gated credential.
 * 2) Base Sepolia: viem publicClient + wallet-gated signing via ctx.wallet.signTransaction (OWS vault), treasury-aware.
 *
 * Spec: ERC-8004 Identity Registry 0x8004A818BFB912233c491871b3d84c89A494BD9e on Base Sepolia (84532)
 * Card: https://eips.ethereum.org/EIPS/eip-8004#registration-v1
 */

export type AgentCard = {
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1'
  name: string
  description: string
  image?: string
  endpoints: Array<{
    name: string
    endpoint: string
    version?: string
    capabilities?: unknown
  }>
  registrations?: unknown[]
  supportedTrust: string[]
}

export const ERC8004_ABI = [
  {
    type: 'function',
    name: 'register',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'tokenURI', type: 'string' }],
    outputs: [{ name: 'tokenId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'tokenURI',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
] as const

export interface Erc8004BackendOpts {
  baseRpcUrl: string
  identityRegistry: `0x${string}`
  chainId: number
}

export function buildDefaultCard(params: {
  ownerAddress: string
  name?: string | undefined
  description?: string | undefined
  image?: string | undefined
  mcpEndpoint?: string | undefined
  chainId?: number | undefined
}): AgentCard {
  const chainId = params.chainId ?? 84532
  return {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: params.name ?? 'DeepSeek Harness Agent',
    description:
      params.description ??
      'Autonomous agent on DeepSeek Harness (dsh-channel-xmtp + dsh-wallet + dsh-erc8004). Provides XMTP messaging, wallet tools, Filecoin Pin storage, and ERC-8004 verifiable identity.',
    image: params.image ?? 'https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png',
    endpoints: [
      {
        name: 'MCP',
        endpoint: params.mcpEndpoint ?? 'https://api.githubcopilot.com/mcp/',
        version: '1.0.0',
        capabilities: {
          tools: [
            { name: 'wallet_info', description: 'Get agent EVM wallet address and funding instructions' },
            { name: 'get_balances', description: 'Query live or treasury balances across chains' },
            { name: 'synapse_pin', description: 'Persist content with Filecoin PDP proofs' },
            { name: 'erc8004_register', description: 'Register agent card on ERC-8004 Identity Registry' },
          ],
        },
      },
      {
        name: 'agentWallet',
        endpoint: `eip155:${chainId}:${params.ownerAddress}`,
      },
    ],
    registrations: [],
    supportedTrust: ['reputation'],
  }
}

export class Erc8004Backend {
  constructor(private readonly opts: Erc8004BackendOpts) {}

  private async getViem(): Promise<typeof import('viem')> {
    return import('viem')
  }

  private async getChain(): Promise<any> {
    const { defineChain } = await import('viem')
    if (this.opts.chainId === 84532) {
      const { baseSepolia } = await import('viem/chains')
      return baseSepolia
    }
    return defineChain({
      id: this.opts.chainId,
      name: 'erc8004-target',
      network: 'erc8004-target',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [this.opts.baseRpcUrl] } },
    })
  }

  async getPublicClient(): Promise<any> {
    const { createPublicClient, http } = await this.getViem()
    const chain = await this.getChain()
    return createPublicClient({ chain, transport: http(this.opts.baseRpcUrl) })
  }

  async tokenURI(agentId: bigint | string): Promise<string> {
    const publicClient: any = await this.getPublicClient()
    const uri: string = await publicClient.readContract({
      address: this.opts.identityRegistry,
      abi: ERC8004_ABI,
      functionName: 'tokenURI',
      args: [BigInt(agentId)],
    })
    return uri
  }

  async ownerOf(agentId: bigint | string): Promise<`0x${string}`> {
    const publicClient: any = await this.getPublicClient()
    const owner: `0x${string}` = await publicClient.readContract({
      address: this.opts.identityRegistry,
      abi: ERC8004_ABI,
      functionName: 'ownerOf',
      args: [BigInt(agentId)],
    })
    return owner
  }
}
