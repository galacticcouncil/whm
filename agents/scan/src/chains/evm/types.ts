import type { Chain as ViemChain } from "viem";

import type { ChainBase } from "../types";

export interface EvmChain extends ChainBase {
  kind: "evm";
  chain: ViemChain;
  /** Websocket — new heads arrive over eth_subscribe, never by polling. */
  rpcUrl: string;
  chunkSize: bigint;
}
