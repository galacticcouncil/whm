import { createPublicClient, http } from "viem";

import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider";

import { source, destination } from "./config.js";

export const base = createPublicClient({
  transport: http(source.rpcUrl),
});

export const hydration = createClient(getWsProvider(destination.wssUrl));
