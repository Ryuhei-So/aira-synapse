export {
  type ExtractionChunk,
  type CompositeExtractionRecord,
  type CanonicalizationResult,
  type IExtractionAgent,
  type ISchemaCanonicalizer,
} from './extraction.js';

export {
  type ConflictType,
  type ConflictCandidate,
  type ConflictSet,
  type ConflictDetectionRequest,
  type IConflictDetector,
} from './conflictDetection.js';

export {
  type ConflictResolutionState,
  type ResolutionEvidence,
  type ConflictResolution,
  type ConflictResolutionRequest,
  type IConflictResolver,
  isConflictResolutionState,
  hasRequiredEvidence,
  hasNoFactOverlap,
} from './conflictResolution.js';
