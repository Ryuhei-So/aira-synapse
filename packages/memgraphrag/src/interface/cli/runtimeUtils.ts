import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { Command } from 'commander';
import type { MemGraphRagRuntime } from '../runtime/MemGraphRagRuntime.js';
import { createMemGraphRagRuntime } from '../runtime/MemGraphRagRuntime.js';
import { loadMemGraphRagConfig, resolveConfigFromEnv } from '../../infrastructure/config/index.js';

export interface CliContext {
  readonly runtimeFactory?: (configPath?: string) => Promise<MemGraphRagRuntime>;
}

export async function getRuntime(context: CliContext, configPath?: string): Promise<MemGraphRagRuntime> {
  if (context.runtimeFactory) {
    return context.runtimeFactory(configPath);
  }

  const effectiveConfigPath = resolve(
    process.cwd(),
    configPath ?? process.env['MEMGRAPHRAG_CONFIG'] ?? resolve(import.meta.dirname, '../../../config/default.memgraphrag.yml'),
  );
  const config = resolveConfigFromEnv(loadMemGraphRagConfig(effectiveConfigPath));
  const runtime = createMemGraphRagRuntime(config);
  await runtime.start();
  return runtime;
}

export async function withRuntime<T>(
  context: CliContext,
  action: (runtime: MemGraphRagRuntime) => Promise<T>,
  configPath?: string,
): Promise<T> {
  const runtime = await getRuntime(context, configPath);
  try {
    return await action(runtime);
  } finally {
    if (!context.runtimeFactory) {
      await runtime.shutdown();
    }
  }
}

export function renderOutput(value: unknown, json = false): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }

  if (typeof value === 'string') {
    console.log(value);
    return;
  }

  console.log(JSON.stringify(value, null, 2));
}

export function ensureParentDirectory(path: string): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
}

export function listMarkdownFiles(inputPath: string): readonly string[] {
  const absolutePath = resolve(process.cwd(), inputPath);
  const stats = statSync(absolutePath);
  if (stats.isFile()) {
    return extname(absolutePath) === '.md' ? [absolutePath] : [];
  }

  const files: string[] = [];
  for (const entry of readdirSync(absolutePath, { withFileTypes: true })) {
    const entryPath = resolve(absolutePath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listMarkdownFiles(entryPath));
    } else if (entry.isFile() && extname(entry.name) === '.md') {
      files.push(entryPath);
    }
  }
  return files.sort();
}

export function toDocumentId(path: string): string {
  const digest = createHash('sha1').update(path).digest('hex').slice(0, 12);
  return `doc_${digest}`;
}

export function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8')) as T;
}

export function writeTextFile(path: string, text: string): void {
  const absolutePath = resolve(process.cwd(), path);
  mkdirSync(resolve(absolutePath, '..'), { recursive: true });
  writeFileSync(absolutePath, text, 'utf8');
}

export function titleFromPath(path: string): string {
  return basename(path, extname(path));
}

export function attachCommonOptions(command: Command): Command {
  return command.option('--config <path>', 'Path to MemGraphRAG config file');
}
