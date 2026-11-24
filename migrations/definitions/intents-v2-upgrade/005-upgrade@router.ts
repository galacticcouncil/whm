import { resolve } from "node:path";

import type { MigrationStep } from "./types";
import { upgradeRouter } from "../../actions/intent-router/upgrade";

const step: MigrationStep = {
  name: "005-upgrade@router",
  description: "Upgrade the NEAR intent router with settle and UTXO routes — its owner still holds it, so this is a step",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };
    return await upgradeRouter({
      ...ctx.wallet.near,
      router: required("NEAR_ROUTER"),
      wasmPath: resolve(required("ROUTER_WASM")),
    });
  },
};

export default step;
