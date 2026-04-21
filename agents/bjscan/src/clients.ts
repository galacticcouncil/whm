import { createPublicClient, http } from "viem";

import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider";

import { source, destination } from "./config";

export const sourceClient = createPublicClient({
  transport: http(source.rpcUrl),
});

export const destinationClient = createClient(getWsProvider(destination.wssUrl));
