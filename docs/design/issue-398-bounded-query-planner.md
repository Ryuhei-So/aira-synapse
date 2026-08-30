# Issue #398 bounded query planner checkpoint

## Authority and boundary

Synapse remains the sole authority for V15 query normalization, feature-profile
admission, embedding-provider construction, comparison detection, and
`V15RetrievalRequestPlan`. Literature Hub owns generation sessions, availability,
and transport; GraphDB owns bounded execution and work counters.

The new planner is a read-free application seam: it validates the complete V15
feature profile and the request fields used by the plan, normalizes the query,
obtains one embedding through the configured Synapse provider, and returns the
existing canonical plan. It has no graph, vector-index, memory-store, SQLite,
migration, path, descriptor, lease, deadline, or response authority.

```text
Hub request -> Synapse bounded planner -> V15 plan
                                      -> Hub generation session
                                      -> native bounded operations
```

## Invariants and state

- Unsupported feature profiles and malformed request fields fail before the
  embedding provider is called.
- Empty or non-finite embeddings fail before any owner/native call.
- Planner output is accepted only through the existing strict V15 plan
  validator; policy constants are shared with `DefaultQueryService`.
- Construction from `MemGraphRagConfig` reuses the runtime's embedding-provider
  factory and never opens or creates configured storage paths.
- The only retained state is the embedding provider's existing bounded cache.
  Session exclusivity, renewal, decreasing deadlines, and cleanup remain Hub's
  responsibility through `BoundedGenerationSession`.

## Failure, compatibility, and rollback

All failures are pre-session and publish no partial retrieval result. Existing
`MemGraphRagRuntime`, legacy retrieval, and storage startup remain unchanged.
Rollback removes the additive planner export; no schema, data, migration, or
production-service change is involved. Hub must pin a Synapse build containing
this seam before using it and must fail closed if the export is absent.

Existing persisted vectors use the embedding model's default dimensions because
runtime construction historically did not forward the optional config field.
The planner preserves that authority. Enabling a configured dimension requires
a separately designed vector-generation migration, not a retrieval-only change.

## Privacy and logging

The planner adds no logging or durable artifact. Query text and embeddings stay
within the existing in-process/provider path and are not added to errors.

## Non-goals

- No GraphDB transport, generation lease, deadline, work-counter, or result
  validation logic in Synapse beyond the already-landed session contract.
- No `memory_load`, full snapshot, storage startup, migration, timeout increase,
  alternate query, semantic change, or production activation.

## Adversarial acceptance tests

- The planner's plan is byte-for-byte equal to the existing QueryService plan
  for the same prepared V15 request and embedding.
- Every unsupported feature flag and malformed request rejects before embedding.
- Empty/non-finite embeddings reject and never return a plan.
- A config with nonexistent storage paths can construct and execute the planner
  through its configured provider without creating or opening those paths.
- The runtime and planner use one embedding-provider factory; adding/changing a
  provider branch cannot silently update only one path.
