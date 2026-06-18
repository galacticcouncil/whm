import { createPublicClient, webSocket, type PublicClient } from "viem";

import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider";

import { sources, destination } from "./config";

export const sourceClients: Record<string, PublicClient> = Object.fromEntries(
  sources.map((s) => [
    s.name,
    createPublicClient({
      transport: webSocket(s.rpcUrl, {
        keepAlive: { interval: 30_000 },
        reconnect: { attempts: Infinity, delay: 2_000 },
      }),
    }),
  ])
);

export const destinationClient = createClient(getWsProvider(destination.wssUrl));
