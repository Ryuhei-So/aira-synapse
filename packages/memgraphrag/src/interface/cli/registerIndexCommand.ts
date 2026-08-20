import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import type { IndexingService } from '../../application/index.js';
import { SERVICE_TOKENS } from '../runtime/MemGraphRagRuntime.js';
import type { CliContext } from './runtimeUtils.js';
import { listMarkdownFiles, renderOutput, titleFromPath, toDocumentId, withRuntime } from './runtimeUtils.js';

export function registerIndexCommand(program: Command, context: CliContext = {}): void {
  const command = program
    .command('index')
    .description('Index markdown documents into a corpus')
    .requiredOption('--corpus-id <id>', 'Corpus identifier')
    .requiredOption('--input <path>', 'Input file or directory')
    .requiredOption('--config <path>', 'Path to configuration file')
    .option('--json', 'Emit JSON output', false);

  command.action(async (options: { corpusId: string; input: string; config: string; json: boolean }) => {
    await withRuntime(context, async (runtime) => {
      const indexingService = runtime.getService<IndexingService>(SERVICE_TOKENS.INDEXING_SERVICE);
      const documents = listMarkdownFiles(options.input).map((path) => ({
        documentId: toDocumentId(path),
        markdown: readFileSync(resolve(path), 'utf8'),
        title: titleFromPath(path),
        sourceUrl: resolve(path),
        sourceType: 'md' as const,
        language: 'unknown' as const,
      }));
      const result = await indexingService.start({ corpusId: options.corpusId, documents });
      // Run the enqueued job to completion; without this the CLI exits and the
      // shutdown hook cancels the still-pending job.
      await indexingService.resume(result.jobId);
      renderOutput({ job_id: result.jobId, document_count: documents.length }, options.json);
    }, options.config);
  });
}
