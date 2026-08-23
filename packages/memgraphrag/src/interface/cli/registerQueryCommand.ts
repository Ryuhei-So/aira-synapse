import type { Command } from 'commander';
import type { QueryService } from '../../application/index.js';
import { SERVICE_TOKENS } from '../runtime/MemGraphRagRuntime.js';
import type { CliContext } from './runtimeUtils.js';
import { attachCommonOptions, renderOutput, withRuntime } from './runtimeUtils.js';

export function registerQueryCommand(program: Command, context: CliContext = {}): void {
  const command = attachCommonOptions(
    program
      .command('query')
      .description('Query a corpus')
      .requiredOption('--corpus-id <id>', 'Corpus identifier')
      .requiredOption('--query <text>', 'Query text')
      .option('--top-k <number>', 'Top K passages', '10')
      .option('--top-m <number>', 'Top M entities', '5')
      .option('--threshold <number>', 'Similarity threshold', '0.5')
      .option('--json', 'Emit JSON output', false),
  );

  command.action(async (options: { corpusId: string; query: string; topK: string; topM: string; threshold: string; config?: string; json: boolean }) => {
    await withRuntime(context, async (runtime) => {
      const queryService = runtime.getService<QueryService>(SERVICE_TOKENS.QUERY_SERVICE);
      const result = await queryService.query({
        corpusId: options.corpusId,
        text: options.query,
        topK: Number(options.topK),
        topM: Number(options.topM),
        threshold: Number(options.threshold),
        contextTokenLimit: 8000,
      });
      renderOutput(result, options.json);
    }, options.config);
  });
}
