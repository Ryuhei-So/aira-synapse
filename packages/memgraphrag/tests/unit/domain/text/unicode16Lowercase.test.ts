import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  UNICODE16_LOWERCASE_DIGEST,
  unicode16Lowercase,
} from '../../../../src/domain/text/unicode16Lowercase.js';

const fixturePath = fileURLToPath(new URL('../../../fixtures/unicode16-lowercase.conformance.bin', import.meta.url));
const ambientOracleEnabled = process.env.UNICODE16_AMBIENT_ORACLE === '1';
if (ambientOracleEnabled && (process.version !== 'v24.11.1' || process.versions.unicode !== '16.0')) {
  throw new Error('UNICODE16_AMBIENT_ORACLE requires Node v24.11.1 with Unicode 16.0');
}

describe('Unicode 16 lowercase authority', () => {
  it.skipIf(!ambientOracleEnabled)(
    'matches Node 24 for every Unicode scalar in all Final Sigma contexts',
    () => {
      const mismatches: Array<{ input: string; actual: string; expected: string }> = [];
      const check = (input: string): void => {
        const expected = input.toLowerCase();
        const actual = unicode16Lowercase(input);
        if (actual !== expected && mismatches.length < 5) mismatches.push({ input, actual, expected });
      };

      for (let value = 0; value <= 0x10FFFF; value += 1) {
        if (value >= 0xD800 && value <= 0xDFFF) continue;
        const scalar = String.fromCodePoint(value);
        check(`${scalar}Σ`);
        check(`AΣ${scalar}`);
        check(`A${scalar}Σ`);
        check(`AΣ${scalar}A`);
      }

      expect(mismatches).toEqual([]);
    },
  );

  it('matches every Unicode scalar and all manifested Final Sigma vectors', async () => {
    const fixture = await readFile(fixturePath);
    expect(fixture.subarray(0, 8).toString('ascii')).toBe('U16LOW1\0');
    const scalarCount = fixture.readUInt32LE(8);
    const vectorCount = fixture.readUInt32LE(12);
    expect(scalarCount).toBe(0x110000 - 0x800);

    let offset = 16;
    let checked = 0;
    let ambientMismatchCount = 0;
    let firstMismatch: { scalar: number; actual: string; expected: string } | undefined;
    for (let scalar = 0; scalar <= 0x10FFFF; scalar += 1) {
      if (scalar >= 0xD800 && scalar <= 0xDFFF) continue;
      const length = fixture.readUInt8(offset);
      offset += 1;
      const expectedScalars: number[] = [];
      for (let index = 0; index < length; index += 1) {
        expectedScalars.push(fixture.readUInt32LE(offset));
        offset += 4;
      }
      const input = String.fromCodePoint(scalar);
      const actual = unicode16Lowercase(input);
      const expected = String.fromCodePoint(...expectedScalars);
      if (actual !== expected && firstMismatch === undefined) firstMismatch = { scalar, actual, expected };
      if (input.toLowerCase() !== expected) ambientMismatchCount += 1;
      checked += 1;
    }
    const vectorsLength = fixture.readUInt32LE(offset);
    offset += 4;
    const vectors = JSON.parse(fixture.subarray(offset, offset + vectorsLength).toString('utf8')) as Array<{ input: string; output: string }>;
    offset += vectorsLength;

    expect(firstMismatch).toBeUndefined();
    expect(checked).toBe(scalarCount);
    if (process.versions.unicode === '16.0') expect(ambientMismatchCount).toBe(0);
    else expect(ambientMismatchCount).toBeGreaterThan(0);
    expect(vectors).toHaveLength(vectorCount);
    for (const vector of vectors) expect(unicode16Lowercase(vector.input)).toBe(vector.output);
    expect(offset).toBe(fixture.length);
  }, 20_000);

  it('does not delegate authority to the host lowercase implementation', () => {
    const original = String.prototype.toLowerCase;
    String.prototype.toLowerCase = () => { throw new Error('ambient lowercase was called'); };
    try {
      expect(unicode16Lowercase('ÄLPHA AΣ\u0301')).toBe('älpha aς\u0301');
    } finally {
      String.prototype.toLowerCase = original;
    }
  });

  it('rejects malformed UTF-16 instead of normalizing replacement data', () => {
    expect(() => unicode16Lowercase('\uD800')).toThrow(/unpaired high surrogate/);
    expect(() => unicode16Lowercase('\uDC00')).toThrow(/unpaired low surrogate/);
    expect(() => unicode16Lowercase(`A\uD800B`)).toThrow(/unpaired high surrogate/);
  });

  it('normalizes long values without spreading the complete output as call arguments', () => {
    expect(unicode16Lowercase('A'.repeat(1_000_000))).toBe('a'.repeat(1_000_000));
  });

  it('handles a long contextual value without retaining scalar or chunk arrays', () => {
    const input = `${'A'.repeat(100_000)}Σ${'\u0301'.repeat(100_000)}!`;
    const output = unicode16Lowercase(input);
    expect(output.startsWith(`${'a'.repeat(100_000)}ς`)).toBe(true);
    expect(output.endsWith(`${'́'.repeat(100_000)}!`)).toBe(true);
    expect(output).toHaveLength(input.length);
    expect(() => unicode16Lowercase(`${input}\uD800`)).toThrow(/unpaired high surrogate/);
  });

  it('uses the pinned table even when the ambient runtime has a newer Unicode mapping', () => {
    expect(UNICODE16_LOWERCASE_DIGEST).toBe('v15-entity-normalization-ecmascript-tolowercase-unicode16.0.0@1');
    expect(unicode16Lowercase('\uA7CE')).toBe('\uA7CE');
    if (process.versions.unicode !== '16.0') {
      expect('\uA7CE'.toLowerCase()).not.toBe(unicode16Lowercase('\uA7CE'));
    }
  });
});
