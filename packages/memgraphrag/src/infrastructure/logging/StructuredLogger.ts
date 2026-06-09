import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SecretMasker } from '../security/SecretMasker.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  readonly [key: string]: unknown;
}

export interface StructuredLogEntry {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly context: LogContext;
}

export class StructuredLogger {
  private readonly masker = new SecretMasker();

  public constructor(private readonly logPath: string) {}

  public log(level: LogLevel, message: string, context: LogContext = {}): StructuredLogEntry {
    const absolutePath = resolve(process.cwd(), this.logPath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    const entry: StructuredLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message: this.masker.mask(message),
      context: this.masker.maskObject(context),
    };
    appendFileSync(absolutePath, `${JSON.stringify(entry)}\n`, 'utf8');
    return entry;
  }
}
