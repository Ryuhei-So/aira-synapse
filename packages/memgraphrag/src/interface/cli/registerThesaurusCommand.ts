import { Command } from 'commander';
import type { ThesaurusService } from '../../application/index.js';
import { SERVICE_TOKENS } from '../runtime/MemGraphRagRuntime.js';
import type { CliContext } from './runtimeUtils.js';
import { attachCommonOptions, readJsonFile, renderOutput, withRuntime, writeTextFile } from './runtimeUtils.js';

export function registerThesaurusCommand(program: Command, context: CliContext = {}): void {
  const command = attachCommonOptions(
    program
      .command('thesaurus')
      .description('Manage thesaurus relations')
      .argument('<action>', 'import | export | lookup | stats')
      .requiredOption('--corpus-id <id>', 'Corpus identifier')
      .option('--file <path>', 'Input/output JSON file')
      .option('--term <term>', 'Lookup term')
      .option('--json', 'Emit JSON output', false),
  );

  command.action(async (action: 'import' | 'export' | 'lookup' | 'stats', options: { corpusId: string; file?: string; term?: string; config?: string; json: boolean }) => {
    await withRuntime(context, async (runtime) => {
      const service = runtime.getService<ThesaurusService>(SERVICE_TOKENS.THESAURUS_SERVICE);

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

      if (action === 'lookup') {
        const result = await service.handle({ corpusId: options.corpusId, action: 'lookup', term: options.term });
        renderOutput(result, options.json);
        return;
      }

      const result = await service.handle({ corpusId: options.corpusId, action: 'stats' });
      renderOutput(result.statistics ?? {}, options.json);
    }, options.config);
  });
}
