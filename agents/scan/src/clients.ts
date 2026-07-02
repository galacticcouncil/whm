import { createPublicClient, webSocket, type PublicClient } from "viem";

import { createClient, type PolkadotClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";

import { chains } from "./config";

export interface ChainClient {
  kind: "evm" | "substrate";
  evm?: PublicClient;
  substrate?: PolkadotClient;
}

/** One client per enabled chain: viem websocket for EVM, polkadot-api for substrate. */
export const clients: Record<string, ChainClient> = {};

for (const [name, c] of Object.entries(chains)) {
  if (c.kind === "evm") {
    clients[name] = {
      kind: "evm",
      evm: createPublicClient({
        transport: webSocket(c.rpcUrl, {
          keepAlive: { interval: 30_000 },
          reconnect: { attempts: Infinity, delay: 2_000 },
        }),
      }),
    };
  } else {
    clients[name] = { kind: "substrate", substrate: createClient(getWsProvider(c.wssUrl)) };
  }
}
