/**
 * Application Layer — Soft timeout utility for federated query.
 * DES-FED-006: Promise.race based timeout with deferred cleanup.
 */

export interface SoftTimeoutResult<T> {
  readonly status: 'success' | 'timeout' | 'failure';
  readonly value?: T;
  readonly error?: string;
  readonly latencyMs: number;
}

/**
 * Execute a promise with a soft timeout.
 * On timeout, the original promise continues in the background.
 * The cleanup function is called after the original promise settles (success or failure).
 */
export async function executeWithSoftTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  cleanup?: () => Promise<void>,
): Promise<SoftTimeoutResult<T>> {
  const startTime = Date.now();

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('__soft_timeout__')), timeoutMs);
  });

  try {
    const value = await Promise.race([work, timeoutPromise]);
    return {
      status: 'success',
      value,
      latencyMs: Date.now() - startTime,
    };
  } catch (err) {
    const isTimeout = err instanceof Error && err.message === '__soft_timeout__';
    const latencyMs = Date.now() - startTime;

    if (isTimeout && cleanup) {
      // Defer cleanup until the work settles
      work
        .then(() => cleanup())
        .catch(() => cleanup())
        .catch(() => { /* swallow cleanup errors */ });
    }

    return {
      status: isTimeout ? 'timeout' : 'failure',
      error: err instanceof Error ? err.message : String(err),
      latencyMs,
    };
  }
}
