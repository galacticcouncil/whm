import type { ChainBase } from "../types";

export interface SubstrateChain extends ChainBase {
  kind: "substrate";
  chainId: number;
  wssUrl: string;
  /** Blocks between cursor writes during a backfill. */
  checkpointEvery: number;
}
