export interface MetricSnapshot {
  readonly counters: Readonly<Record<string, number>>;
  readonly timings: Readonly<Record<string, { count: number; totalMs: number; avgMs: number }>>;
}

export class MetricsCollector {
  private readonly counters = new Map<string, number>();
  private readonly timings = new Map<string, { count: number; totalMs: number }>();

  public increment(name: string, value = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  }

  public recordTiming(name: string, durationMs: number): void {
    const current = this.timings.get(name) ?? { count: 0, totalMs: 0 };
    current.count += 1;
    current.totalMs += durationMs;
    this.timings.set(name, current);
  }

  public snapshot(): MetricSnapshot {
    return {
      counters: Object.fromEntries(this.counters),
      timings: Object.fromEntries([...this.timings.entries()].map(([name, metric]) => [name, {
        count: metric.count,
        totalMs: metric.totalMs,
        avgMs: metric.count === 0 ? 0 : metric.totalMs / metric.count,
      }])),
    };
  }
}
