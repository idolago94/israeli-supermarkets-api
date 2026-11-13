// ─── Per-chain circuit breaker ────────────────────────────────────────────────
//
// Counts the final outcome of each branch in a chain job (after its retries).
// Once at least `minSamples` branches have finished and more than
// `threshold` of them failed, the breaker opens: the chain stops starting new
// branches, so a portal that is down isn't hammered ~100 more times. Other
// chains each have their own breaker and keep going.

export class CircuitBreaker {
  private ok = 0;
  private failed = 0;

  constructor(
    private readonly threshold: number,
    private readonly minSamples: number,
  ) {}

  record(outcome: 'ok' | 'failed'): void {
    if (outcome === 'ok') this.ok++;
    else this.failed++;
  }

  get samples(): number {
    return this.ok + this.failed;
  }

  get failureRatio(): number {
    return this.samples ? this.failed / this.samples : 0;
  }

  get open(): boolean {
    return this.samples >= this.minSamples && this.failureRatio > this.threshold;
  }
}
