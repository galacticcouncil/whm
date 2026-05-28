import { Chain } from "viem";
import { base, mainnet } from "viem/chains";

import { hydration } from "./hydration";
import { moonbeam } from "./moonbeam";

const chains: Record<number, Chain> = {
  1: mainnet,
  222222: hydration,
  1284: moonbeam,
  8453: base,
};

export function getChain(chainId: number): Chain {
  const chain = chains[chainId];
  if (!chain) {
    throw new Error("Register chain " + chainId);
  }
  return chain;
}
