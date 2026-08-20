import { Command } from 'commander';
import { Agent, setGlobalDispatcher } from 'undici';
import { registerConflictsCommand } from './registerConflictsCommand.js';

// Local OpenAI-compatible backends (shared Ollama) can take >5min per call
// under load; undici's default 300s headersTimeout would abort them.
setGlobalDispatcher(new Agent({ headersTimeout: 30 * 60 * 1000, bodyTimeout: 30 * 60 * 1000 }));
import { registerDictionaryCommand } from './registerDictionaryCommand.js';
import { registerIndexCommand } from './registerIndexCommand.js';
import { registerInitCommand } from './registerInitCommand.js';
import { registerLexiconCommand } from './registerLexiconCommand.js';
import { registerQueryCommand } from './registerQueryCommand.js';
import { registerStatsCommand } from './registerStatsCommand.js';
import { registerThesaurusCommand } from './registerThesaurusCommand.js';
import { registerVisualizeCommand } from './registerVisualizeCommand.js';
import type { CliContext } from './runtimeUtils.js';

export function createCli(context: CliContext = {}): Command {
  const program = new Command();
  program
    .name('memgraphrag')
    .version('0.1.0')
    .description('MemGraphRAG CLI');

  registerIndexCommand(program, context);
  registerQueryCommand(program, context);
  registerStatsCommand(program, context);
  registerInitCommand(program);
  registerDictionaryCommand(program, context);
  registerLexiconCommand(program, context);
  registerThesaurusCommand(program, context);
  registerVisualizeCommand(program, context);
  registerConflictsCommand(program, context);

  return program;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await createCli().parseAsync(process.argv);
}
