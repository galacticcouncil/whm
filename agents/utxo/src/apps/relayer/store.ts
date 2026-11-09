import type { Redis } from "ioredis";

/** Processed records stay readable this long. */
const CLOSED_TTL_S = 30 * 24 * 3600;

/** One `WithdrawRequested`, kept until `A`'s balance has left for the destination chain. */
export interface Withdrawal {
  chain: string;
  /** The coin's NTT manager sequence — with `chain`, the record's id. */
  sequence: string;
  /** The derived account `A`, lowercase hex. */
  account: string;
  /** The destination address string. */
  address: string;
  /** What settled to `A`, net of the fee, in the chain's base unit. */
  amount: string;
  block: string;
  /** `mismatch`: the event's account is not what its address derives — never worked. */
  state: "open" | "withdrawn" | "mismatch";
  createdAt: number;
  updatedAt: number;
  withdrawTx?: string;
  lastError?: string;
}

/**
 * Redis: a JSON value per record, the set of open record ids, and the watcher's cursor. A closed
 * record leaves the set and expires.
 */
export class Store {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {}

  /** The last Hydration block the watcher finished, or null on a fresh store. */
  async cursor(): Promise<bigint | null> {
    const v = await this.redis.get(`${this.prefix}:cursor`);
    return v === null ? null : BigInt(v);
  }

  /**
   * @param block The last Hydration block the watcher finished.
   */
  async saveCursor(block: bigint): Promise<void> {
    await this.redis.set(`${this.prefix}:cursor`, block.toString());
  }

  /**
   * Add a record unless it is known — a rescan never resets one.
   *
   * @param w The record.
   * @returns Whether it was added.
   */
  async add(w: Withdrawal): Promise<boolean> {
    const added = await this.redis.set(this.key(w), JSON.stringify(w), "NX");
    if (!added) return false;
    if (w.state === "open") await this.redis.sadd(this.openKey(), this.id(w));
    else await this.redis.expire(this.key(w), CLOSED_TTL_S);
    return true;
  }

  /** Every open record, oldest first. */
  async open(): Promise<Withdrawal[]> {
    const ids = await this.redis.smembers(this.openKey());
    if (ids.length === 0) return [];
    const values = await this.redis.mget(ids.map((id) => `${this.prefix}:${id}`));
    return values
      .filter((v): v is string => v !== null)
      .map((v) => JSON.parse(v) as Withdrawal)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Record why a pass did not get a withdrawal out; it stays open.
   *
   * @param w The record.
   * @param error What went wrong.
   */
  async fail(w: Withdrawal, error: string): Promise<void> {
    await this.redis.set(this.key(w), JSON.stringify({ ...w, lastError: error, updatedAt: Date.now() }));
  }

  /**
   * Close a record as withdrawn.
   *
   * @param w The record.
   * @param withdrawTx The relay transaction.
   */
  async withdrawn(w: Withdrawal, withdrawTx: string): Promise<void> {
    const closed: Withdrawal = { ...w, state: "withdrawn", withdrawTx, lastError: undefined, updatedAt: Date.now() };
    await this.redis
      .multi()
      .set(this.key(w), JSON.stringify(closed), "EX", CLOSED_TTL_S)
      .srem(this.openKey(), this.id(w))
      .exec();
  }

  private id(w: Withdrawal): string {
    return `${w.chain}:${w.sequence}`;
  }

  private key(w: Withdrawal): string {
    return `${this.prefix}:${this.id(w)}`;
  }

  private openKey(): string {
    return `${this.prefix}:open`;
  }
}
