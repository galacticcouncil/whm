import { createPublicClient, http, type PublicClient } from "viem";

import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider";

import { sources, destination } from "./config";

export const sourceClients: Record<string, PublicClient> = Object.fromEntries(
  sources.map((s) => [s.name, createPublicClient({ transport: http(s.rpcUrl) })]),
);

export const destinationClient = createClient(getWsProvider(destination.wssUrl));
