import { createPublicClient, webSocket, type PublicClient } from "viem";
import { mainnet } from "viem/chains";

import { source } from "./config";

export const client: PublicClient = createPublicClient({
  chain: mainnet,
  // eth_subscribe push subscription (no polling); never give up reconnecting — a successful open
  // resets viem's attempt counter, so this only bounds a single uninterrupted outage.
  transport: webSocket(source.wssUrl, { reconnect: { attempts: 1_000_000 } }),
});
