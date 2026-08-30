# Bounded retrieval semantic wire contract

Status: implementation checkpoint for upstream issue #3. This document extends
the already-merged V15 plan/session boundary; it does not authorize native
algorithms, Hub wiring, parity evidence, or production activation.

## Authority split

Synapse is the sole authority for the semantic payload and result shapes of:

- `candidate_search_bounded@1`;
- `fact_expand_bounded@1`; and
- `ppr_materialize_bounded@1`.

The new artifact covers only fields whose meaning Synapse owns: corpus, slots,
vectors, thresholds, limits, expansion plans, PPR plans, ordered hits/ranks,
scores, convergence output, and references to the existing domain-object
contract. It deliberately excludes request IDs, generation/session identity,
remaining time, work counters, allocation estimates, response bytes, native
error envelopes, retry policy, and transport framing.

Aira GraphDB must pin the exact artifact bytes and compose them with one
native-owned execution contract for exact generation, decreasing remaining
budget, checked work/allocation counters, deadline/error behavior, and bounded
framing. Literature Hub then owns the generation session and availability
policy. Neither downstream repository may restate Synapse field meaning or
copy a second allow-list.

## One executable source

The existing structural-contract DSL in `domainContract.ts` is extracted to a
neutral contract utility and reused by both domain objects and bounded
retrieval. It gains a discriminated-union node whose discriminator is one
required literal field; type inference preserves the correlation between the
discriminator, namespace, and referenced domain-object kind, while runtime
validation selects exactly one branch and rejects an unknown or ambiguous
tag. One declaration must drive:

1. TypeScript compile-time witnesses against the already-exported V15 plan and
   bounded-port semantic projections;
2. strict recursive runtime validation, including unknown keys, missing keys,
   non-finite numbers, non-plain objects, sparse/decorated arrays, and external
   domain-object references; and
3. deterministic generated contract and fixture artifacts.

Structural nodes are not the authority for relational semantics. Each
operation declaration also carries a closed, versioned refinement program.
The v1 refinement IR has no user code, named policy callback, or free-form
expression node. Collection predicates are drawn only from `length_eq`,
`length_lte_ref`, `tuple_tags`, `unique_by`, and
`ordered_score_desc_id_asc`. Scalar expression nodes are drawn only from
`literal`, `pointer`, `iteration_pointer`, `array_length`, `array_at`,
`set_contains`, `map_lookup`, `normalize_ref`, `concat`, `coalesce`, `max`,
`multiply`, `eq`, `lt`, `lte`, `not`, `all`, and `any`; assertions add only
`finite_range`, `safe_integer_range`, `field_eq_ref`, `prefixed_identity`,
`corpus_eq_ref`, and `rank_is_index_plus_one`. Operands are JSON Pointers
rooted at `request` or `result`; wildcards range only over arrays already
validated structurally. Every fact-expansion and PPR metric rule is serialized
as a complete canonical expression tree using these nodes: exclusion, both
normalized entity lookups, max/coalesce/attenuation score equality, iteration
bounds, convergence equivalence, and the zero-iteration special case. No
opaque `*_policy_v15` opcode is permitted.

`normalize_ref` names an exact-byte dependency on the existing Unicode 16
normalization manifest, native lookup, and conformance fixture. Unknown node,
IR version, dependency identity, unresolved pointer, type mismatch, or false
predicate fails closed. The current Synapse validators are refactored to
interpret the same canonical program, and the native implementation must
interpret those bytes too; neither may maintain a parallel list of relational
checks.

An external reference node identifies one of `passage`, `fact`, or `schema`
and a dependency entry containing the domain contract and manifest versions,
repository-relative canonical paths, byte counts, and SHA-256 hashes. It
delegates runtime validation to those exact pinned bytes and never embeds or
copies their field list.

## Artifact set and identity

The producer publishes a separate immutable set under the dedicated directory
`packages/memgraphrag/tests/fixtures/bounded-retrieval/`:

- `bounded-retrieval-contract.json` — the complete semantic declarations;
- `bounded-retrieval-fixture.json` — one valid request and result for every
  operation, reusing generated domain fixture objects; and
- `bounded-retrieval-fixture.manifest.json` — versions, filenames, byte counts,
  and SHA-256 hashes.

Canonical bytes use the existing recursive key sort, two-space JSON,
UTF-8, and one trailing LF. The generator writes mode-0600 temporary files,
syncs, atomically renames, and supports a read-only `--check`. The package adds
matching generate/check scripts, and CI runs `--check` after build.

Every dependency path is canonical relative to the pinned repository root,
uses `/` separators, and contains neither an empty, `.`, nor `..` segment.
Absolute paths, backslashes, symlinks in any path component, non-regular final
entries, or resolution outside that root fail closed. The retrieval manifest
records exact dependencies on
`packages/memgraphrag/tests/fixtures/bounded-domain-contract.json`,
`packages/memgraphrag/tests/fixtures/bounded-domain-fixture.manifest.json`,
`packages/memgraphrag/tests/fixtures/unicode16-lowercase.manifest.json`,
`packages/memgraphrag/tests/fixtures/unicode16-lowercase.lookup.rs`, and
`packages/memgraphrag/tests/fixtures/unicode16-lowercase.conformance.bin`:
repository-relative paths, byte counts, SHA-256 hashes, and the applicable
contract, manifest, normalization, and format versions. The generator verifies
those bytes before publishing or checking retrieval artifacts. GraphDB pins
the three retrieval files, all five dependency files, source repository,
`production-runtime` commit, source paths, byte counts, and hashes. A version
label by itself never authorizes a dependency.

An operation semantic digest is the SHA-256 of that operation's canonical
structural declaration plus refinement program as produced by the same
generator. GraphDB may advertise a composed native schema digest, but it must
retain and expose this producer digest separately.

## Invariants

- The three method names and semantic schemas are closed and versioned.
- Candidate slots preserve exact order and require unique stable slot IDs;
  V15's fixture uses passage, fact, schema in canonical order.
- Every numeric semantic value is finite. Threshold is in `[-1, 1]`;
  probabilities and convergence values follow the existing V15 validators;
  counts are positive safe integers within plan-owned limits.
- Candidate hits are score-descending then native-ID ascending, unique per
  slot, threshold-satisfying, and namespace/domain-reference consistent; these
  constraints are refinement IR, not downstream prose.
- Expansion and PPR shapes reuse the current V15 plan builders and validators;
  their cross-field rules are fully expanded portable refinement programs,
  and no default or comparison-query inference appears in the artifact.
- Domain objects are external references to
  `aira-synapse-domain-contract@1`, never duplicated structural definitions.
- The semantic request/result projections omit generation and session identity
  only at the artifact boundary; compile-time witnesses prove that all other
  existing port fields are represented exactly.
- Artifact validation occurs before any downstream corpus-sized work.

## Failure and compatibility

Unknown versions, missing/extra fields, artifact/hash mismatch, invalid
external references, non-finite numbers, invalid order, or a fixture that no
longer passes current validators fail closed. No generated file is partially
published. Logs and public artifacts contain no production data, paths, query
text, or document identifiers beyond fixed synthetic fixture values.

This is additive to the unactivated bounded path. Rollback selects the prior
Synapse revision; it changes no persisted data and requires no migration.
Existing legacy retrieval behavior is untouched.

## Adversarial checkpoint

Before implementation is approved, tests must prove:

1. compile-time bidirectional shape witnesses reject a missing, extra, renamed,
   optionalized, or retyped semantic field;
2. every operation request/result fixture passes the same runtime declaration
   that produces the artifact;
3. unknown/missing fields, NaN/infinity, sparse/decorated arrays, wrong slot
   order/namespace, duplicate IDs, threshold failure, wrong rank/order, and a
   wrong domain reference fail closed;
4. `lstat` proves the dedicated retrieval directory contains exactly the three
   named regular files and no extra file, directory, nested entry, symlink,
   socket, FIFO, or device; modification, deletion, size overflow, retrieval
   or dependency hash mismatch, and partial manifest fail `--check`;
5. generated bytes are deterministic and operation digests change whenever an
   owned structural or refinement declaration changes;
6. the artifact contains no generation, session, deadline/budget, work,
   allocation, retry, transport, or native-error fields;
7. mutation coverage exercises every refinement node and proves an unknown
   node, version, dependency, non-canonical path, pointer, or cross-field
   violation fails closed; and
8. source/static guards prove this checkpoint adds no `memory_load`, global
   projection, native algorithm, Hub adapter, parity evaluator, or production
   activation path.

Only after this boundary and its negative tests receive fresh review may the
GraphDB pin and native execution contract begin.
