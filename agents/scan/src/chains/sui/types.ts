import type { ChainBase } from "../types";

/**
 * Sui is read through its GraphQL service: every transaction that touched an NTT manager's shared
 * state, with its calls, inputs and events. Checkpoints are final, so one is the cursor.
 */
export interface SuiChain extends ChainBase {
  kind: "sui";
  graphqlUrl: string;
  /** How often the managers' transactions are re-read. */
  pollMs: number;
}

/** A programmable transaction's input, as far as decoding needs one. */
export type Input =
  | { __typename: "MoveValue"; type: { repr: string }; bcs: string }
  | { __typename: "SharedInput"; address: string }
  | { __typename: string };

/** One transaction, as the watcher's query returns it. */
export interface Tx {
  digest: string;
  sender: { address: string } | null;
  effects: {
    status: string;
    /** ISO 8601. */
    timestamp: string;
    checkpoint: { sequenceNumber: number };
    events: { nodes: { contents: { type: { repr: string }; json: Record<string, unknown> } }[] };
  };
  kind: {
    __typename: string;
    inputs?: { nodes: Input[] };
    commands?: {
      nodes: {
        __typename: string;
        function?: { name: string; module: { name: string; package: { address: string } } };
      }[];
    };
  };
}
