import { copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { writeTextFile } from './runtimeUtils.js';

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Write a default MemGraphRAG config file')
    .requiredOption('--output <path>', 'Output config path')
    .action(async (options: { output: string }) => {
      const source = resolve(import.meta.dirname, '../../../config/default.memgraphrag.yml');
      const target = resolve(process.cwd(), options.output);
      writeTextFile(target, '');
      copyFileSync(source, target);
      console.log(`Wrote default config to ${target}`);
    });
}
