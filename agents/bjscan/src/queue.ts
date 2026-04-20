/** Bounded async queue with backpressure. */
export class BoundedQueue<T> {
  private buffer: T[] = [];
  private pushWaiters: (() => void)[] = [];
  private takeWaiters: (() => void)[] = [];
  private closed = false;

  constructor(private readonly maxSize: number) {}

  async push(item: T): Promise<void> {
    while (this.buffer.length >= this.maxSize && !this.closed) {
      await new Promise<void>((r) => this.pushWaiters.push(r));
    }
    if (this.closed) return;
    this.buffer.push(item);
    this.takeWaiters.shift()?.();
  }

  async take(): Promise<T | null> {
    while (this.buffer.length === 0 && !this.closed) {
      await new Promise<void>((r) => this.takeWaiters.push(r));
    }
    if (this.buffer.length === 0) return null;
    const item = this.buffer.shift()!;
    this.pushWaiters.shift()?.();
    return item;
  }

  close(): void {
    this.closed = true;
    for (const r of this.pushWaiters) r();
    for (const r of this.takeWaiters) r();
    this.pushWaiters = [];
    this.takeWaiters = [];
  }
}
