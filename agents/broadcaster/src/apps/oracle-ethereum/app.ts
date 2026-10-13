import { wallet } from "@whm/common/evm";

import { boot } from "../../loop.js";
import { createEvmBroadcaster } from "../../evm/broadcaster.js";
import { signingKey } from "../../evm/signer.js";

import { RPC } from "./config.js";
import { CHAIN_ID, ROUTES } from "./routes.js";

boot(() =>
  createEvmBroadcaster({
    name: "oracle-ethereum",
    wallet: wallet.getWallet(RPC, CHAIN_ID, signingKey()),
    routes: ROUTES,
  }),
);
