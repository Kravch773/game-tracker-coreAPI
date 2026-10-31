// Paces calls to one store. The daily sweep goes slowly and steps aside: a visitor's request takes the next
// slot, and the sweep then waits a full gap so the store sees no burst. A 429 parks the store for the time it
// asks; while parked, a visitor's request is told to use the stored price instead of queueing behind the wait.
export class StoreGate {
  private last = 0;
  private yieldUntil = 0;
  private blockedUntil = 0;

  constructor(
    private readonly sweepGapMs: number,
    private readonly urgentGapMs: number,
  ) {}

  blocked(): boolean {
    return Date.now() < this.blockedUntil;
  }

  // Throws a StoreBusyError instead of waiting when the store is parked or the wait would be long.
  // The slot is booked before waiting, so callers arriving together line up instead of firing at once.
  async urgent(maxWaitMs: number): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.blockedUntil, this.last + this.urgentGapMs);
    if (at - now > maxWaitMs) throw new StoreBusyError();
    this.last = at;
    this.yieldUntil = Math.max(this.yieldUntil, at + this.sweepGapMs);
    if (at > now) await sleep(at - now);
  }

  // A visitor booking a slot meanwhile pushes the sweep back, so it checks again after each wait.
  async sweep(): Promise<void> {
    for (;;) {
      const now = Date.now();
      const at = Math.max(now, this.blockedUntil, this.yieldUntil, this.last + this.sweepGapMs);
      if (at <= now) break;
      await sleep(at - now);
    }
    this.last = Date.now();
  }

  // Retry-After in seconds when the store gave one, else a minute.
  backOff(retryAfter: string | null): void {
    const seconds = Number(retryAfter);
    const ms = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 900) * 1000 : 60_000;
    this.blockedUntil = Math.max(this.blockedUntil, Date.now() + ms);
  }
}

export class StoreBusyError extends Error {}

export class StoreLimitError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter: string | null,
  ) {
    super(`Store answered ${status}`);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Steam is asked about 50 games at a time; the PlayStation Store one page at a time.
export const steamGate = new StoreGate(2_000, 250);
export const playstationGate = new StoreGate(4_000, 500);
