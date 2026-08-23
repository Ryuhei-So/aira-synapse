import { describe, expect, it, vi } from 'vitest';
import { openLadybugDatabase } from '../../../../src/infrastructure/storage/ladybug/LadybugConnection.js';

describe('openLadybugDatabase', () => {
  it('passes maxDBSize as the official fifth constructor argument', () => {
    const Database = vi.fn(() => ({ close: vi.fn() }));
    const ldb = { Database };

    openLadybugDatabase(ldb, 'test.lbug', 1024 ** 3);

    expect(Database).toHaveBeenCalledWith('test.lbug', 0, true, false, 1024 ** 3);
  });

  it('preserves the legacy one-argument constructor when maxDBSize is omitted', () => {
    const Database = vi.fn(() => ({ close: vi.fn() }));
    const ldb = { Database };

    openLadybugDatabase(ldb, 'test.lbug');

    expect(Database).toHaveBeenCalledWith('test.lbug');
  });
});
