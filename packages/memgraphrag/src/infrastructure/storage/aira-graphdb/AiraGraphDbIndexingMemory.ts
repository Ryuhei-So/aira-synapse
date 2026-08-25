import {
  INDEXING_MEMORY_CONTRACT,
  type ActivateFactsRequest,
  type ActiveFactRequest,
  type IIndexingMemory,
  type IndexingMemoryDelta,
  type IndexingMemoryMutationPlan,
  type IndexingSchemaRequest,
} from '../../../domain/storage/indexingMemory.js';
import {
  validateActivatedResult,
  validateActivationRequest,
  validateActiveFactRequest,
  validateActiveFactResponse,
  validateMutationPlan,
  validateSchemaRequest,
  validateSchemaResponse,
} from '../indexingMemoryContract.js';
import type {
  AiraGraphDbRpcClient,
  NativeRequestLimits,
} from './NativeClient.js';

type JsonObject = Record<string, unknown>;

const PROTOCOL_VERSION = 'native-method-policy@1';
const PROTOCOL_LIMITS: NativeRequestLimits = {
  maxRequestBytes: 1024 * 1024,
  maxResponseBytes: 1024 * 1024,
};
const INDEXING_LIMITS: NativeRequestLimits = {
  maxRequestBytes: INDEXING_MEMORY_CONTRACT.maxRequestBytes,
  maxResponseBytes: INDEXING_MEMORY_CONTRACT.maxResponseBytes,
};
const REQUIRED_METHODS = new Map([
  ['memory_get_schemas_by_ids', { classification: 'read', wal: false }],
  ['memory_get_active_facts', { classification: 'read', wal: false }],
  ['memory_activate_facts_by_schema_ids', { classification: 'mutation', wal: true }],
  ['memory_upsert', { classification: 'mutation', wal: true }],
] as const);

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, name: string): JsonObject {
  if (!isObject(value)) throw new Error(`${name} must be an object`);
  return value;
}

function validateProtocolInfo(value: unknown): void {
  const protocol = requireObject(value, 'protocol_info result');
  if (protocol.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`unsupported aira-graphdb protocolVersion: ${String(protocol.protocolVersion)}`);
  }
  if (!Number.isSafeInteger(protocol.generation) || (protocol.generation as number) < 0) {
    throw new Error('aira-graphdb protocol generation is invalid');
  }
  if (protocol.state !== 'idle'
    || (protocol.readOnly !== undefined && protocol.readOnly !== false)) {
    throw new Error(`aira-graphdb must start idle and writable (state=${String(protocol.state)})`);
  }

  const limits = requireObject(protocol.limits, 'protocol_info.limits');
  const indexing = requireObject(limits.indexingMemory, 'protocol_info.limits.indexingMemory');
  for (const [name, expected] of Object.entries(INDEXING_MEMORY_CONTRACT)) {
    if (indexing[name] !== expected) {
      throw new Error(`aira-graphdb indexing capability mismatch for ${name}`);
    }
  }
  const wal = requireObject(limits.wal, 'protocol_info.limits.wal');
  if (wal.mutationRequestIdUniqueness !== 'activeTransaction') {
    throw new Error('aira-graphdb mutation request ID scope is incompatible');
  }

  if (!Array.isArray(protocol.methods)) {
    throw new Error('protocol_info.methods must be an array');
  }
  const methods = new Map<string, JsonObject>();
  for (const [index, candidate] of protocol.methods.entries()) {
    const method = requireObject(candidate, `protocol_info.methods[${index}]`);
    if (typeof method.name !== 'string' || methods.has(method.name)) {
      throw new Error('protocol_info.methods contains an invalid or duplicate name');
    }
    methods.set(method.name, method);
  }
  for (const [name, expected] of REQUIRED_METHODS) {
    const method = methods.get(name);
    if (!method
      || method.classification !== expected.classification
      || method.wal !== expected.wal) {
      throw new Error(`aira-graphdb method contract mismatch for ${name}`);
    }
  }
}

export class AiraGraphDbIndexingMemory implements IIndexingMemory {
  private constructor(private readonly client: AiraGraphDbRpcClient) {}

  public static async create(client: AiraGraphDbRpcClient): Promise<AiraGraphDbIndexingMemory> {
    const protocol = await client.request<unknown>('protocol_info', {}, PROTOCOL_LIMITS);
    validateProtocolInfo(protocol);
    return new AiraGraphDbIndexingMemory(client);
  }

  public async getSchemasByIds(request: IndexingSchemaRequest) {
    validateSchemaRequest(request);
    const response = await this.client.request<unknown>(
      'memory_get_schemas_by_ids',
      request,
      INDEXING_LIMITS,
    );
    return validateSchemaResponse(response, request);
  }

  public async getActiveFacts(request: ActiveFactRequest) {
    validateActiveFactRequest(request);
    const response = await this.client.request<unknown>(
      'memory_get_active_facts',
      request,
      INDEXING_LIMITS,
    );
    return validateActiveFactResponse(response, request);
  }

  public preflightMutation(plan: IndexingMemoryMutationPlan): void {
    validateMutationPlan(plan);
  }

  public async activateFactsBySchemaIds(request: ActivateFactsRequest): Promise<number> {
    validateActivationRequest(request);
    const response = await this.client.request<unknown>(
      'memory_activate_facts_by_schema_ids',
      request,
      INDEXING_LIMITS,
    );
    return validateActivatedResult(response);
  }

  public async upsertDelta(delta: IndexingMemoryDelta): Promise<void> {
    validateMutationPlan({ delta });
    const response = await this.client.request<unknown>('memory_upsert', delta, INDEXING_LIMITS);
    if (response !== null) {
      throw new Error('memory_upsert response must be null');
    }
  }
}
