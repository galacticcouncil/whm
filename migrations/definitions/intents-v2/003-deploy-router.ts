import { resolve } from "node:path";

import { nearToYocto } from "near-api-js";
import { pad } from "viem";

import type { MigrationStep } from "./types";
import { deployRouter } from "../../actions/intent-router/deploy";

/** Hydration's Wormhole chain id — where the orders are published. */
const HYDRATION_WORMHOLE_ID = 73;

const step: MigrationStep = {
  name: "003-deploy-router",
  description: "Create the router account on NEAR, deploy the intent router and initialise it",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };
    const int = (k: string) => {
      const v = Number(required(k));
      if (!Number.isInteger(v) || v < 0) throw new Error(`${k} must be a non-negative integer: ${ctx.env[k]}`);
      return v;
    };

    // The router pins the dispatcher at init and has no setter: read it from 001, never copy it.
    const dispatcher = ctx.outputs["001-deploy-dispatcher"].proxyAddress as `0x${string}`;

    return await deployRouter({
      ...ctx.wallet.near,
      prefix: required("ROUTER_PREFIX"),
      balance: nearToYocto(required("ROUTER_BALANCE") as `${number}`),
      wasmPath: resolve(required("ROUTER_WASM")),
      mpcSigner: required("MPC_SIGNER_NEAR"),
      intents: required("INTENTS_NEAR"),
      core: required("WORMHOLE_CORE_NEAR"),
      emitterChain: HYDRATION_WORMHOLE_ID,
      emitter: pad(dispatcher, { size: 32 }),
      ethToken: required("ETH_TOKEN_NEAR"),
      quoteKeys: required("QUOTE_KEYS").split(",").map((k) => k.trim()),
      params: {
        price_validity: int("ROUTER_PRICE_VALIDITY"),
        max_quote_age: int("ROUTER_MAX_QUOTE_AGE"),
        min_quote_slippage_bps: int("ROUTER_MIN_QUOTE_SLIPPAGE_BPS"),
        transfer_validity: int("ROUTER_TRANSFER_VALIDITY"),
        max_order_shortfall_bps: int("ROUTER_MAX_ORDER_SHORTFALL_BPS"),
        min_refund: required("ROUTER_MIN_REFUND"),
      },
    });
  },
};

export default step;
