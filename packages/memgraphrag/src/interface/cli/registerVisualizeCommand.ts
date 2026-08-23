import type { Command } from 'commander';
import type { CorpusManager } from '../../application/index.js';
import { SERVICE_TOKENS } from '../runtime/MemGraphRagRuntime.js';
import type { CliContext } from './runtimeUtils.js';
import { attachCommonOptions, withRuntime, writeTextFile } from './runtimeUtils.js';

export function registerVisualizeCommand(program: Command, context: CliContext = {}): void {
  const command = attachCommonOptions(
    program
      .command('visualize')
      .description('Export graph data to a file')
      .requiredOption('--corpus-id <id>', 'Corpus identifier')
      .requiredOption('--format <format>', 'graphml|json')
      .requiredOption('--output <path>', 'Output path'),
  );

  command.action(async (options: { corpusId: string; format: 'graphml' | 'json'; output: string; config?: string }) => {
    await withRuntime(context, async (runtime) => {
      const corpusManager = runtime.getService<CorpusManager>(SERVICE_TOKENS.CORPUS_MANAGER);
      const result = await corpusManager.exportGraph(options.corpusId, options.format, 0, 10000);
      writeTextFile(options.output, result.data);
      console.log(`Wrote ${result.format} graph to ${options.output}`);
    }, options.config);
  });
}
