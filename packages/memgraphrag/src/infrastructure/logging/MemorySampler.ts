export class MemorySampler {
  public sampleRss(): number {
    return process.memoryUsage().rss / (1024 * 1024);
  }

  public assertBudget(limitMB: number): number {
    const rss = this.sampleRss();
    if (rss > limitMB) {
      throw new Error(`Memory budget exceeded: rss=${rss.toFixed(2)}MB limit=${limitMB}MB`);
    }
    return rss;
  }
}
