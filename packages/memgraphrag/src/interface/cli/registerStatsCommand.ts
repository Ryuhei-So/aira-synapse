import type { Command } from 'commander';
import type { CorpusManager } from '../../application/index.js';
import { SERVICE_TOKENS } from '../runtime/MemGraphRagRuntime.js';
import type { CliContext } from './runtimeUtils.js';
import { attachCommonOptions, renderOutput, withRuntime } from './runtimeUtils.js';

export function registerStatsCommand(program: Command, context: CliContext = {}): void {
  const command = attachCommonOptions(
    program
      .command('stats')
      .description('Show corpus statistics')
      .requiredOption('--corpus-id <id>', 'Corpus identifier')
      .option('--json', 'Emit JSON output', false),
  );

  command.action(async (options: { corpusId: string; config?: string; json: boolean }) => {
    await withRuntime(context, async (runtime) => {
      const corpusManager = runtime.getService<CorpusManager>(SERVICE_TOKENS.CORPUS_MANAGER);
      const result = await corpusManager.getStats(options.corpusId);
      renderOutput(result, options.json);
    }, options.config);
  });
}
