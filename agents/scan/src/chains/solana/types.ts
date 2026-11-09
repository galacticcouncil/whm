import type { ChainBase } from "../types";

/**
 * Solana has no event log NTT writes to, so it is read the way NEAR is: the signatures of the
 * programs we own, then those transactions whole, decoded instruction by instruction.
 */
export interface SolanaChain extends ChainBase {
  kind: "solana";
  rpcUrl: string;
  /** Optional: a websocket whose log notices prompt a read before the next poll. */
  wssUrl?: string;
  /** How often the signatures are re-read. */
  pollMs: number;
}

/** One row of `getSignaturesForAddress`, newest first. */
export interface SignatureRow {
  signature: string;
  slot: number;
  err: unknown;
}

/** An instruction as `getTransaction` returns it in `json` encoding. */
export interface RawInstruction {
  programIdIndex: number;
  accounts: number[];
  /** Base58. */
  data: string;
  stackHeight?: number | null;
}

/** A transaction whole, as `getTransaction` returns it in `json` encoding. */
export interface Tx {
  slot: number;
  /** Unix seconds. */
  blockTime: number | null;
  transaction: {
    signatures: string[];
    message: { accountKeys: string[]; instructions: RawInstruction[] };
  };
  meta: {
    err: unknown;
    logMessages: string[] | null;
    innerInstructions: { index: number; instructions: RawInstruction[] }[] | null;
    loadedAddresses?: { writable: string[]; readonly: string[] };
  };
}

/** An instruction resolved: who ran it, who called it, and where it sits. */
export interface Instruction {
  program: string;
  /** The program that invoked it, or null at the top level. */
  caller: string | null;
  data: Uint8Array;
  accounts: string[];
  /** Position in the transaction — top-level slot plus inner position — stable however much is kept. */
  index: number;
  depth: number;
  /** Instructions it invoked, transitively. */
  children: Instruction[];
}
