import { Command } from 'commander';
import { registerConflictsCommand } from './registerConflictsCommand.js';
import { registerDictionaryCommand } from './registerDictionaryCommand.js';
import { registerIndexCommand } from './registerIndexCommand.js';
import { registerInitCommand } from './registerInitCommand.js';
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
  registerThesaurusCommand(program, context);
  registerVisualizeCommand(program, context);
  registerConflictsCommand(program, context);

  return program;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await createCli().parseAsync(process.argv);
}
