import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';

export interface SemanticScholarCacheRecord<T> {
  readonly expiresAt: number;
  readonly value: T;
}

export class SemanticScholarCache {
  public constructor(
    private readonly cacheDir: string,
    private readonly ttlMs = 24 * 60 * 60 * 1000,
  ) {}

  public getKey(parts: readonly unknown[]): string {
    return createHash('sha1').update(JSON.stringify(parts)).digest('hex');
  }

  public getPath(key: string): string {
    return resolve(this.cacheDir, `${key}.json`);
  }

  public get<T>(key: string, now = Date.now()): T | null {
    const path = this.getPath(key);
    if (!existsSync(path)) {
      return null;
    }

    try {
      const record = JSON.parse(readFileSync(path, 'utf8')) as SemanticScholarCacheRecord<T>;
      if (record.expiresAt <= now) {
        return null;
      }
      return record.value;
    } catch {
      return null;
    }
  }

  public set<T>(key: string, value: T, now = Date.now()): void {
    const path = this.getPath(key);
    mkdirSync(dirname(path), { recursive: true });
    const record: SemanticScholarCacheRecord<T> = {
      expiresAt: now + this.ttlMs,
      value,
    };
    writeFileSync(path, JSON.stringify(record, null, 2), 'utf8');
  }
}
