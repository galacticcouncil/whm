import { Chain } from "viem";
import { base } from "viem/chains";

import { hydration } from "./hydration";
import { moonbeam } from "./moonbeam";

const chains: Record<number, Chain> = {
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
