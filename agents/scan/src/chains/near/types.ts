import type { ChainBase } from "../types";

/**
 * NEAR has no log filter and no head subscription worth the name, so it is read through FastNEAR's
 * transaction index: the history of the accounts we own, then those transactions whole.
 */
export interface NearChain extends ChainBase {
  kind: "near";
  /** FastNEAR transactions API — `/v0/account` and `/v0/transactions`. */
  txApi: string;
  /** How often the histories are re-read. */
  pollMs: number;
}

/** One row of an account's history, newest first. */
export interface HistoryRow {
  transaction_hash: string;
  tx_block_height: number;
}

export interface Outcome {
  block_height: number;
  /** Nanoseconds. */
  block_timestamp: number;
  index: number;
  outcome: {
    executor_id: string;
    logs: string[];
    /** The receipts this one spawned. */
    receipt_ids: string[];
    status: Record<string, unknown>;
  };
}

export interface Action {
  FunctionCall?: { method_name: string; args: string };
}

export interface Receipt {
  receipt: {
    receipt_id: string;
    predecessor_id: string;
    receipt: { Action?: { actions: (Action | string)[] } };
  };
  execution_outcome: Outcome;
}

/** A transaction whole, as FastNEAR returns it. */
export interface Tx {
  transaction: { hash: string };
  receipts: Receipt[];
}

/**
 * One NEP-297 event, or one call kept as one (`standard: "call"`, `event`: the method, `data`: its
 * arguments), in a successful receipt.
 */
export interface NearLog {
  standard: string;
  event: string;
  data: unknown;
  /** The contract that logged it, or was called. */
  executor: string;
  predecessor: string;
  /** Position in the transaction — receipt slot plus event — stable however much is kept. */
  index: number;
  blockHeight: number;
  /** Unix ms. */
  blockTimestamp: number;
}
