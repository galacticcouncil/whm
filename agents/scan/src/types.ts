import type { AbiEvent } from "viem";

// ─── Ingest ──────────────────────────────────────────────────────

/**
 * One contract set to index, and the unit a cursor is kept for. Adding an entry backfills only that
 * entry from its own `from` — nothing else on the chain moves.
 */
export interface Watch {
  chain: string;
  /** Stable name a flow addresses this contract set by; never an address. */
  role: string;
  /**
   * The cursor's name, defaulting to `role`. A role that gains contracts later gets a second entry
   * under its own id, so those backfill from their own `from` while the first stays at the tip.
   */
  id?: string;
  from: bigint;
  /**
   * Contracts whose events are kept — addresses; account ids on NEAR; programs on Solana; on Sui,
   * the NTT state objects and the core's package.
   */
  at: string[];
  /**
   * NEAR, Solana and Sui: accounts whose transaction history surfaces `at`'s events, defaulting to
   * `at`. A shared contract — the Wormhole core, a connector — is read through the accounts of ours
   * that call it, never through its own history.
   */
  via?: string[];
  /**
   * NEAR only: calls into `at` kept as events carrying their arguments, for what a call says and no
   * log does.
   */
  calls?: string[];
  /**
   * Positional topic filter. An array in a slot is an OR; a null matches anything. On Solana and Sui
   * it is applied to the topics their watchers store — a publish's emitter is its second.
   */
  topics?: (`0x${string}` | `0x${string}`[] | null)[];
  /**
   * Resolve who sent the transaction, for events that do not say. Costs a receipt lookup per
   * matched transaction, so it is opt-in rather than the default. EVM only — a substrate EVM.Log
   * has no EVM origin to read.
   */
  sender?: boolean;
}

// ─── Events ──────────────────────────────────────────────────────

/** Where an event happened. Stored as JSONB on the row a leg writes. */
export interface EventRef {
  chain: string;
  blockNumber: string;
  /** Unix ms, written at ingest — a feature never asks a node for it. */
  blockTimestamp: number;
  txHash: string;
  logIndex: number;
  /**
   * Substrate only: `<block>-<index>` of the extrinsic it ran in. What a Hydration event without an
   * ethereum transaction is linked by — it came in as a substrate call.
   */
  extrinsic?: string;
}

/** A decoded log, handed to a leg. */
export interface LogEvent<A = Record<string, unknown>> {
  chain: string;
  role: string;
  address: string;
  ref: EventRef;
  /** Who sent the transaction — only where the watch entry asked ingest to resolve it. */
  sender?: string;
  eventName: string;
  args: A;
}

// ─── Flows ───────────────────────────────────────────────────────

/**
 * One event a flow observes.
 *
 * `key` returns the row this event belongs to, or null to drop it — shared infrastructure emits
 * plenty that isn't ours. It may be async and is handed the drain's transaction, because not every
 * event names its own record: a delivery that carries no sequence has to be matched against what is
 * already stored, and that match has to see the same rows the rest of the batch is writing.
 *
 * `keyBy` names the column that key addresses, defaulting to the flow's primary key; a leg keying
 * on an alternate unique column can only land after the leg that bound that column, which within a
 * transaction log order guarantees.
 */
export interface Leg<A = any> {
  role: string;
  /** The EVM event. Exactly one of `abi` and `near`. */
  abi?: AbiEvent;
  /**
   * A JSON event: NEP-297, a NEAR call kept as one (`standard: "call"`, `event`: the method), or
   * what the Solana and Sui watchers decode a transaction into (`chains/events.ts`).
   */
  near?: NearEvent;
  state: string;
  keyBy?: string;
  key: (args: A, ev: LogEvent<A>, db: Queryable) => string | null | Promise<string | null>;
  patch: (args: A, ev: LogEvent<A>) => Record<string, unknown>;
}

/** A NEAR event's identity — NEP-297's `standard` and `event`. */
export interface NearEvent {
  standard: string;
  event: string;
}

/** The subset of a pg client a leg may use — enough to read, never enough to manage a transaction. */
export interface Queryable {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

/**
 * A table, the events that fill it, and how far a row has got.
 *
 * Legs sharing a key are the same record — that is the whole of what "belongs together" means here.
 * State advances by rank and never regresses, so legs may arrive in any order; equal ranks are
 * alternative outcomes rather than a sequence.
 */
export interface Flow {
  name: string;
  table: string;
  key: { column: string; type: string };
  /** Alternate unique columns a leg may address the row by. */
  unique?: string[];
  states: Record<string, number>;
  /**
   * Ref column to the ref column it presupposes. A row carrying a leg whose prerequisite is missing
   * — a delivery whose origin was never indexed — is an orphan, hidden from lists and counts rather
   * than shown half-built. Two refs may name the same prerequisite where a lifecycle branches.
   * Omit where every row stands on its own.
   */
  requires?: Record<string, string>;
  columns: Record<string, string>;
  legs: Leg[];
  indexes?: string[];
}
