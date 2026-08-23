#!/usr/bin/env node

import { runV15ParityEvidenceCli } from '../dist/interface/cli/v15ParityEvidenceCli.js';

try {
  const [operation, ...args] = process.argv.slice(2);
  process.stdout.write(await runV15ParityEvidenceCli(operation, args));
} catch (error) {
  const code = error instanceof Error && error.message.startsWith('USAGE:')
    ? error.message
    : 'V15_PARITY_CHECK_FAILED';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
