import type { Chain } from "viem";
import { mainnet } from "viem/chains";

export interface EvmChainDef {
  /** The key everything else addresses the chain by. */
  name: string;
  chain: Chain;
  wormholeId: number;
  /** Env prefix, e.g. `ETHEREUM` for `RPC_ETHEREUM_WSS`. */
  prefix: string;
}

export const ETHEREUM: EvmChainDef = {
  name: "ethereum",
  chain: mainnet,
  wormholeId: 2,
  prefix: "ETHEREUM",
};

export const EVM_CHAINS: EvmChainDef[] = [ETHEREUM];
