import type { EvmChain } from "./evm/types";
import type { NearChain } from "./near/types";
import type { SubstrateChain } from "./substrate/types";

export type ChainKind = "evm" | "substrate" | "near";

export interface ChainBase {
  name: string;
  kind: ChainKind;
  /** Wormhole chain id — the first component of a VAA id. */
  wormholeId: number;
  /** Blocks behind the head that ingest treats as final. */
  confirmations: bigint;
  concurrency: number;
}

export type ChainCfg = EvmChain | SubstrateChain | NearChain;

/** What every watcher is to ingest and to /api/status. */
export interface Watcher {
  readonly cfg: ChainCfg;
  start(): Promise<void>;
  latestSafe(): Promise<bigint>;
}
