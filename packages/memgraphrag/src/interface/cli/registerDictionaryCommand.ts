import { Command } from 'commander';
import type { DictionaryService } from '../../application/index.js';
import { SERVICE_TOKENS } from '../runtime/MemGraphRagRuntime.js';
import type { CliContext } from './runtimeUtils.js';
import { attachCommonOptions, readJsonFile, renderOutput, withRuntime, writeTextFile } from './runtimeUtils.js';

export function registerDictionaryCommand(program: Command, context: CliContext = {}): void {
  const command = attachCommonOptions(
    program
      .command('dictionary')
      .description('Manage dictionary entries')
      .argument('<action>', 'build | import | export | stats')
      .requiredOption('--corpus-id <id>', 'Corpus identifier')
      .option('--file <path>', 'Input/output JSON file')
      .option('--domain <value>', 'Comma-separated domains for build')
      .option('--json', 'Emit JSON output', false),
  );

  command.action(async (action: 'build' | 'import' | 'export' | 'stats', options: { corpusId: string; file?: string; domain?: string; config?: string; json: boolean }) => {
    await withRuntime(context, async (runtime) => {
      const service = runtime.getService<DictionaryService>(SERVICE_TOKENS.DICTIONARY_SERVICE) as DictionaryService & {
        buildFromApi(corpusId: string, domains: readonly string[], maxPapers: number): Promise<unknown>;
      };

      if (action === 'build') {
        const result = await service.buildFromApi(
          options.corpusId,
          (options.domain ?? '').split(',').map((value) => value.trim()).filter(Boolean),
          100,
        );
        renderOutput(result, options.json);
        return;
      }

      if (action === 'import') {
        const data = options.file ? readJsonFile<readonly Record<string, unknown>[]>(options.file) : [];
        const result = await service.handle({ corpusId: options.corpusId, action: 'import', data: data as never });
        renderOutput(result, options.json);
        return;
      }

      if (action === 'export') {
        const result = await service.handle({ corpusId: options.corpusId, action: 'export' });
        if (options.file) {
          writeTextFile(options.file, JSON.stringify(result.exportData ?? {}, null, 2));
        }
        renderOutput(result.exportData ?? {}, options.json);
        return;
      }

      const result = await service.handle({ corpusId: options.corpusId, action: 'stats' });
      renderOutput(result.statistics ?? {}, options.json);
    }, options.config);
  });
}
