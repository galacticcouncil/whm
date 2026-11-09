import type { Chain as ViemChain } from "viem";

import type { ChainBase } from "../types";

export interface EvmChain extends ChainBase {
  kind: "evm";
  chain: ViemChain;
  /** A websocket subscribes to new heads; an HTTP url is polled for them. */
  rpcUrl: string;
  chunkSize: bigint;
}
