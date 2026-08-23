import type { Command } from 'commander';
import { SERVICE_TOKENS } from '../runtime/MemGraphRagRuntime.js';
import type { CliContext } from './runtimeUtils.js';
import { attachCommonOptions, renderOutput, withRuntime } from './runtimeUtils.js';
import { LexiconBuilder } from '../../application/indexing/LexiconBuilder.js';

import type { ITermDictionary } from '../../domain/dictionary/termDictionary.js';
import type Database from 'better-sqlite3';

export function registerLexiconCommand(program: Command, context: CliContext = {}): void {
  const command = attachCommonOptions(
    program
      .command('lexicon')
      .description('Build/backfill lexicon from indexed corpus')
      .argument('<action>', 'backfill | stats')
      .requiredOption('--corpus-id <id>', 'Corpus identifier')
      .option('--json', 'Emit JSON output', false),
  );

  command.action(async (action: 'backfill' | 'stats', options: { corpusId: string; config?: string; json: boolean }) => {
    await withRuntime(context, async (runtime) => {
      const dictionary = runtime.getService<ITermDictionary>(SERVICE_TOKENS.TERM_DICTIONARY);
      const db = runtime.getService<Database.Database>(SERVICE_TOKENS.DB);

      if (action === 'backfill') {
        const builder = new LexiconBuilder(dictionary, db, options.corpusId);
        const result = await builder.backfill();
        renderOutput(result, options.json);
        return;
      }

      // stats: show dictionary statistics
      const stats = await dictionary.getStatistics();
      renderOutput(stats, options.json);
    }, options.config);
  });
}
