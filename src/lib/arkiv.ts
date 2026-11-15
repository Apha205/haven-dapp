/**
 * Arkiv SDK Client Configuration
 * 
 * Provides a TypeScript client for querying Arkiv blockchain entities.
 * Uses @arkiv-network/sdk with a public client for read-only operations.
 * 
 * IMPORTANT: All Arkiv queries MUST go through the SDK, not via direct
 * HTTP calls or blockchain RPC. The SDK handles query formatting,
 * pagination, and entity parsing correctly.
 */

import {
  createPublicClient,
  type Entity,
  type SelectArg,
  type PublicArkivClient,
  NoEntityFoundError,
} from '@arkiv-network/sdk'
import { http, type Hex, type Transport, type Chain } from 'viem'
import { rabdi } from '@arkiv-network/sdk/chains'
import { asc, eq, type Expression } from '@arkiv-network/sdk/query'
import { toChainId } from './gate-chains'
import type { TokenGate } from '@/types/attestation'
import { toAttributeRecord } from './arkiv-attrs'
import {
  parseCreatedAtBlock,
  pickLatestArkivEntity,
} from './arkiv-recency'

// ============================================================================
// Configuration
// ============================================================================

const ARKIV_RPC_URL = process.env.NEXT_PUBLIC_ARKIV_RPC_URL ||
  'https://rpc.rabdi.db-chain.testnet.arkiv.network'

// ============================================================================
// Types
// ============================================================================

/**
 * Arkiv entity type (matches SDK response).
 */
export interface ArkivEntity {
  key: string
  owner: string
  attributes: Record<string, unknown>
  payload: string // Base64 encoded JSON
  content_type: string
  /** `$createdAtBlock` as decimal string (legacy wire field) */
  created_at: string
  /** Arkiv creation block height — canonical recency key */
  created_at_block: number
}

/**
 * Options for querying entities.
 */
export interface ArkivQueryOptions {
  /** Maximum number of results to return per page */
  maxResults?: number
  /** Cursor for pagination */
  cursor?: string
  /** Include payload data */
  includePayload?: boolean
  /** Include attributes */
  includeAttributes?: boolean
  /** Include metadata (owner, created_at, etc.) */
  includeMetadata?: boolean
}

/**
 * Connection status for the Arkiv client.
 */
export interface ArkivConnectionStatus {
  isConnected: boolean
  error?: string
  blockNumber?: bigint
  blockTime?: number
}

/**
 * Custom error class for Arkiv operations.
 */
export class ArkivError extends Error {
  constructor(
    message: string,
    public code?: string,
    public cause?: Error
  ) {
    super(message)
    this.name = 'ArkivError'
  }
}

// ============================================================================
// Client Creation
// ============================================================================

/**
 * Create an Arkiv SDK public client for querying entities.
 * 
 * This client is optimized for browser environments and read-only operations.
 * For read-only queries, no private key is required.
 * 
 * @returns A PublicArkivClient instance configured for the Rabdi chain
 * 
 * @example
 * ```typescript
 * const client = createArkivClient()
 * const entity = await client.getEntity('0x123...')
 * ```
 */
export function createArkivClient(): PublicArkivClient<Transport, Chain | undefined, undefined> {
  // Use custom transport if ARKIV_RPC_URL is provided, otherwise use default
  const transport = http(ARKIV_RPC_URL)
  
  return createPublicClient({
    // rabdi() requires an access key; "" selects the public endpoint.
    chain: rabdi({ accessKey: '' }),
    transport,
  }) as PublicArkivClient<Transport, Chain | undefined, undefined>
}

// ============================================================================
// Query Operations
// ============================================================================

/**
 * Query entities by owner address using the Arkiv SDK.
 * 
 * @param client - The Arkiv public client instance
 * @param ownerAddress - The Ethereum address of the owner
 * @param options - Optional query parameters
 * @returns Array of entities owned by the specified address
 * 
 * @example
 * ```typescript
 * const client = createArkivClient()
 * const entities = await queryEntitiesByOwner(client, '0x123...', { maxResults: 10 })
 * ```
 */
export async function queryEntitiesByOwner(
  client: PublicArkivClient<Transport, Chain | undefined, undefined>,
  ownerAddress: string,
  options: ArkivQueryOptions = {}
): Promise<ArkivEntity[]> {
  const {
    maxResults = 50,
    cursor,
    includePayload = true,
    includeAttributes = true,
  } = options

  // 1.x flat selection: $-prefixed system fields plus attribute columns.
  // Identity fields are always selected (cheap, and transformEntity needs
  // owner + creation block); payload/attributes honor the include flags so
  // list rows never over-fetch sealed bytes.
  const selection: Record<string, unknown> = {
    $key: true,
    $owner: true,
    $creator: true,
    $createdAt: true,
    $attributes: true,
  }
  if (includeAttributes) selection.$attributes = true
  if (includePayload) selection.payload = true

  try {
    // Upcast to SelectArg so overload resolution picks the dynamic-selection
    // path (FullEntity rows) instead of distributing ProjectedEntity over the
    // EntitySelection union. Safe: EntitySelection is a member of SelectArg.
    // SDK 1.x pages by offset, not cursor — a legacy cursor string carries
    // the decimal offset it pointed at.
    const offset = cursorOffset(cursor)
    let builder = client
      .select(selection as SelectArg)
      .ownedBy(ownerAddress.toLowerCase() as Hex)
      .orderBy(asc('$key'))
      .limit(maxResults)
    if (offset > 0) builder = builder.offset(offset)
    const result = await builder.fetch()

    // Transform SDK Entity to our ArkivEntity format
    return result.entities.map(transformEntity)
  } catch (error) {
    throw new ArkivError(
      error instanceof Error ? error.message : 'Failed to query entities',
      'QUERY_ERROR',
      error instanceof Error ? error : undefined
    )
  }
}

/**
 * Query entities gated by a token, whoever owns them — the community /
 * consumer-library counterpart to queryEntitiesByOwner.
 */
export async function queryEntitiesByGate(
  client: PublicArkivClient<Transport, Chain | undefined, undefined>,
  gate: TokenGate,
  options: ArkivQueryOptions = {}
): Promise<ArkivEntity[]> {
  const { maxResults = 50, cursor } = options
  const chainId = toChainId(gate.chain)
  const where: Expression[] = [eq('grp', 'haven.video.full'), eq('gate_token', gate.tokenAddress)]
  if (chainId !== undefined) where.push(eq('gate_chain', chainId))
  try {
    const offset = cursorOffset(cursor)
    let builder = client.select().where(where).orderBy(asc('$key')).limit(maxResults)
    if (offset > 0) builder = builder.offset(offset)
    const result = await builder.fetch()
    return result.entities.map(transformEntity)
  } catch (error) {
    throw new ArkivError(
      error instanceof Error ? error.message : 'Failed to query entities by gate',
      'QUERY_ERROR',
      error instanceof Error ? error : undefined
    )
  }
}

/**
 * Get a single entity by its key.
 * 
 * @param client - The Arkiv public client instance
 * @param entityKey - The unique key of the entity
 * @returns The entity if found, null otherwise
 */
export async function getEntity(
  client: PublicArkivClient<Transport, Chain | undefined, undefined>,
  entityKey: string
): Promise<ArkivEntity | null> {
  try {
    // 1.x getEntity returns a flat FullEntity row ($-prefixed fields).
    const entity = await client.getEntity(entityKey as `0x${string}`) as unknown as Entity

    if (!entity) {
      return null
    }

    return transformEntity(entity)
  } catch (error) {
    // 0.8 throws on missing keys where 0.7 returned empty — preserve the
    // historical null-on-missing contract for existing callers.
    if (error instanceof NoEntityFoundError) {
      return null
    }
    throw new ArkivError(
      error instanceof Error ? error.message : 'Failed to get entity',
      'GET_ERROR',
      error instanceof Error ? error : undefined
    )
  }
}

/**
 * Check the connection status to the Arkiv network.
 * 
 * @returns Connection status with block information
 */
export async function checkArkivConnection(): Promise<ArkivConnectionStatus> {
  try {
    const client = createArkivClient()
    const blockTiming = await client.getBlockTiming()
    
    return {
      isConnected: true,
      blockNumber: blockTiming.currentBlock,
      blockTime: blockTiming.currentBlockTime,
    }
  } catch (error) {
    return {
      isConnected: false,
      error: error instanceof Error ? error.message : 'Unknown connection error',
    }
  }
}

/**
 * Get all entities for an owner (handles pagination automatically).
 * 
 * @param client - The Arkiv public client instance
 * @param ownerAddress - The Ethereum address of the owner
 * @param maxResults - Maximum total results to fetch (default: 1000)
 * @returns Array of all entities owned by the specified address
 */
export async function getAllEntitiesByOwner(
  client: PublicArkivClient<Transport, Chain | undefined, undefined>,
  ownerAddress: string,
  maxResults: number = 1000
): Promise<ArkivEntity[]> {
  const allEntities: ArkivEntity[] = []
  let offset = 0
  let hasMore = true

  while (hasMore && allEntities.length < maxResults) {
    const pageSize = Math.min(50, maxResults - allEntities.length)

    try {
      const builder = client
        .select()
        .ownedBy(ownerAddress.toLowerCase() as Hex)
        .orderBy(asc('$key'))
        .limit(pageSize)
      if (offset > 0) builder.offset(offset)
      const result = await builder.fetch()
      const entities = result.entities.map(transformEntity)

      allEntities.push(...entities)
      offset += entities.length
      hasMore = entities.length === pageSize
    } catch (error) {
      throw new ArkivError(
        error instanceof Error ? error.message : 'Failed to fetch all entities',
        'FETCH_ALL_ERROR',
        error instanceof Error ? error : undefined
      )
    }
  }
  
  return allEntities
}

/**
 * Get the single most recently created entity for an owner.
 *
 * SDK 0.8 has no server-side ordering, so this fetches the owner's recent
 * page and picks the highest creation block client-side.
 */
export async function getLatestEntityByOwner(
  client: PublicArkivClient<Transport, Chain | undefined, undefined>,
  ownerAddress: string
): Promise<ArkivEntity | null> {
  try {
    const recent = await queryEntitiesByOwner(client, ownerAddress, {
      maxResults: 100,
      includePayload: false,
      includeAttributes: true,
      includeMetadata: true,
    })
    return pickLatestArkivEntity(recent)
  } catch (error) {
    throw new ArkivError(
      error instanceof Error ? error.message : 'Failed to fetch latest entity',
      'FETCH_LATEST_ERROR',
      error instanceof Error ? error : undefined
    )
  }
}

/** Legacy cursor strings carry the decimal offset the page started at. */
function cursorOffset(cursor?: string): number {
  if (!cursor) return 0
  const n = Number.parseInt(cursor, 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Minimal structural view of an SDK entity — satisfied by the SDK 1.x
 * flat row (`$key`/`$owner`/`$createdAt`/`$attributes`/`payload`) and
 * tolerant of legacy/test shapes.
 */
interface RawSdkEntity {
  key?: unknown
  $key?: unknown
  owner?: unknown
  $owner?: unknown
  creator?: unknown
  $creator?: unknown
  createdAt?: unknown
  $createdAt?: unknown
  createdAtBlock?: unknown
  expiresAt?: unknown
  $expiresAt?: unknown
  contentType?: unknown
  content_type?: unknown
  attributes?: unknown
  $attributes?: unknown
  payload?: unknown
}

/**
 * Transform an SDK Entity to our ArkivEntity format.
 *
 * @param entity - The SDK Entity
 * @returns Transformed ArkivEntity
 */
function transformEntity(entity: unknown): ArkivEntity {
  const raw = entity as RawSdkEntity

  // 1.x payload arrives as a tagged bytes value ({ type: "bytes", value: "0x…" }).
  let payload = ''
  const payloadRaw = raw.payload as { type?: string; value?: unknown } | Uint8Array | string | undefined
  if (payloadRaw instanceof Uint8Array) {
    const bytes = new Uint8Array(payloadRaw)
    const binary = bytes.reduce((acc, byte) => acc + String.fromCharCode(byte), '')
    payload = typeof window !== 'undefined'
      ? btoa(binary)
      : Buffer.from(bytes).toString('base64')
  } else if (typeof payloadRaw === 'string') {
    payload = payloadRaw
  } else if (payloadRaw && typeof payloadRaw === 'object' && 'value' in payloadRaw) {
    const v = payloadRaw.value
    if (typeof v === 'string' && /^0x[0-9a-fA-F]*$/.test(v) && v.length % 2 === 0) {
      const hex = v.slice(2)
      const bytes = Uint8Array.from({ length: hex.length / 2 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16))
      const binary = bytes.reduce((acc, byte) => acc + String.fromCharCode(byte), '')
      payload = typeof window !== 'undefined'
        ? btoa(binary)
        : Buffer.from(bytes).toString('base64')
    }
  }

  // Normalize the 1.x flat row (or a legacy nested/array shape) to a record.
  const attributes = toAttributeRecord(raw.$attributes ?? raw.attributes)

  // Get content type from entity or attributes.
  const contentType = (typeof raw.content_type === 'string' && raw.content_type) ||
    (typeof raw.contentType === 'string' && raw.contentType) ||
    (attributes.content_type as string) ||
    (attributes.contentType as string) ||
    'application/octet-stream'

  const keyRaw = raw.$key ?? raw.key
  const ownerRaw = raw.$owner ?? raw.owner ?? raw.$creator ?? raw.creator
  const createdRaw = (raw.$createdAt ?? raw.createdAt ?? raw.createdAtBlock) as
    | string
    | number
    | bigint
    | undefined
    | null
  const createdAtBlock = parseCreatedAtBlock(createdRaw)

  return {
    key: typeof keyRaw === 'string' ? keyRaw : String(keyRaw ?? ''),
    owner: typeof ownerRaw === 'string' ? ownerRaw : '',
    attributes,
    payload,
    content_type: contentType,
    created_at:
      typeof createdRaw === 'bigint'
        ? createdRaw.toString()
        : String(createdRaw ?? ''),
    created_at_block: createdAtBlock,
  }
}

/**
 * Parse entity payload from Base64 JSON string.
 * 
 * @param payload - Base64 encoded JSON string
 * @returns Parsed JSON object
 */
export function parseEntityPayload<T = unknown>(payload: string): T | null {
  try {
    // Try to decode from base64 first
    const decoded = typeof window !== 'undefined' 
      ? atob(payload)
      : Buffer.from(payload, 'base64').toString('utf-8')
    return JSON.parse(decoded) as T
  } catch {
    // If base64 decoding fails, try parsing as regular JSON
    try {
      return JSON.parse(payload) as T
    } catch {
      return null
    }
  }
}

/**
 * Encode payload to Base64 string for storage.
 * 
 * @param data - Data to encode
 * @returns Base64 encoded string
 */
export function encodeEntityPayload<T = unknown>(data: T): string {
  const jsonString = JSON.stringify(data)
  return typeof window !== 'undefined'
    ? btoa(jsonString)
    : Buffer.from(jsonString).toString('base64')
}
