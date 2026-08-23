export {
  type LanguageCode,
  type SchemaState,
  type FactState,
  type MemoryLayer,
  type BridgeKind,
  type ProvenanceSource,
  type Timestamped,
  type CorpusScoped,
  isLanguageCode,
  isSchemaState,
  isFactState,
  isMemoryLayer,
  isBridgeKind,
  isProvenanceSource,
  assertCorpusScoped,
} from './types.js';

export {
  type SchemaAlias,
  type Schema,
  type SchemaCandidate,
  hasExactlyOneCanonicalAlias,
  shouldPromoteToStable,
  computeCanonicalKey,
} from './schema.js';

export {
  type Fact,
  type FactCandidate,
  hasPassageGrounding,
} from './fact.js';

export {
  type DocumentMetadata,
  type Passage,
  hasValidOffsets,
} from './passage.js';

export {
  type MemorySnapshot,
  type MemoryStatistics,
  type GlobalMemory,
} from './globalMemory.js';

export {
  DOMAIN_CONTRACT_VERSION,
  DOMAIN_CONTRACTS,
  PASSAGE_CONTRACT,
  FACT_CONTRACT,
  SCHEMA_CONTRACT,
  validateDomainObject,
  isDomainObject,
  type ContractNode,
  type DomainContractValidation,
  type DomainContractTypeWitness,
  type DomainObjectKind,
  type DomainObjectByKind,
} from './domainContract.js';
