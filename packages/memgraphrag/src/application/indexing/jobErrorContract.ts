import { readFileSync } from 'node:fs';

interface ContractError {
  readonly code: string;
  readonly message: string;
  readonly documentId?: string;
}

interface GraphDbOwnerJobErrorContract {
  readonly contract: 'graphdb-owner-job-errors';
  readonly version: 1;
  readonly ownerError: ContractError;
  readonly documentError: ContractError & { readonly documentId: string };
}

function requireError(value: unknown, name: string, documentScoped: boolean): ContractError {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid ${name} in graphdb owner job-error contract`);
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.code !== 'string' || candidate.code.length === 0
      || typeof candidate.message !== 'string'
      || (documentScoped
        && (typeof candidate.documentId !== 'string' || candidate.documentId.length === 0))) {
    throw new Error(`invalid ${name} in graphdb owner job-error contract`);
  }
  return Object.freeze({
    code: candidate.code,
    message: candidate.message,
    ...(typeof candidate.documentId === 'string'
      ? { documentId: candidate.documentId }
      : {}),
  });
}

export function parseJobErrorContract(rawText: string): GraphDbOwnerJobErrorContract {
  const raw: unknown = JSON.parse(rawText);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('invalid graphdb owner job-error contract');
  }
  const candidate = raw as Record<string, unknown>;
  if (candidate.contract !== 'graphdb-owner-job-errors' || candidate.version !== 1) {
    throw new Error('unsupported graphdb owner job-error contract');
  }
  const ownerError = requireError(candidate.ownerError, 'ownerError', false);
  const documentError = requireError(candidate.documentError, 'documentError', true);
  if (ownerError.code === documentError.code) {
    throw new Error('owner and document job-error codes must be distinct');
  }
  return Object.freeze({
    contract: 'graphdb-owner-job-errors',
    version: 1,
    ownerError,
    documentError: documentError as ContractError & { readonly documentId: string },
  });
}

function loadJobErrorContract(): GraphDbOwnerJobErrorContract {
  return parseJobErrorContract(readFileSync(
    new URL('../../../config/contracts/graphdb-owner-job-errors.json', import.meta.url),
    'utf8',
  ));
}

export const JOB_ERROR_CONTRACT = loadJobErrorContract();
