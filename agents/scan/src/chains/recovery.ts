import log from "../logger";

/**
 * What a watcher's failures are counted against, so a recovery is logged as plainly as the failure
 * was: a run of errors, then one line saying it got through again.
 */
export class Recovery {
  private failed = 0;
  private since = 0;

  /**
   * @param chain The watcher's chain, as its log lines name it.
   * @param what What is failing and recovering — "sweep", "heads", "websocket".
   */
  constructor(
    private readonly chain: string,
    private readonly what: string,
  ) {}

  /** One more failure, the first of a run starting the clock. */
  fail(): void {
    if (this.failed++ === 0) this.since = Date.now();
  }

  /**
   * It got through. Says so only if it had been failing.
   *
   * @param detail Where it got to, for the line.
   */
  ok(detail?: string): void {
    if (this.failed === 0) return;
    const s = Math.round((Date.now() - this.since) / 1000);
    log.info(
      `[${this.chain}] ${this.what} recovered after ${this.failed} failed attempt${this.failed === 1 ? "" : "s"} (${s}s)${detail ? `, ${detail}` : ""}`,
    );
    this.failed = 0;
  }
}
