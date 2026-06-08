/**
 * Shared test doubles for MemGraphRAG tests.
 * Provides mock factories for domain interfaces.
 */

/**
 * Creates a stub that throws with a descriptive message.
 * Use for ports that should not be called in a given test.
 */
export function createNotImplementedStub<T>(name: string): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      if (typeof prop === 'string') {
        return () => {
          throw new Error(
            `${name}.${prop}() should not be called in this test`,
          );
        };
      }
      return undefined;
    },
  });
}

/**
 * Creates a spy-capable partial mock.
 * Pass overrides for methods you want to control.
 */
export function createPartialMock<T extends object>(
  name: string,
  overrides: Partial<T>,
): T {
  const notImpl = createNotImplementedStub<T>(name);
  return { ...notImpl, ...overrides };
}
