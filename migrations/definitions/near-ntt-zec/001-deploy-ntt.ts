import { resolve } from "node:path";

import { nearToYocto } from "near-api-js";

import type { MigrationStep } from "./types";
import { deployNtt } from "../../actions/near-ntt/deploy";

const step: MigrationStep = {
  name: "001-deploy-ntt",
  description: "Create ntt-<token>.<deployer>, deploy ntt-manager and initialise it",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    return await deployNtt({
      ...ctx.wallet.near,
      prefix: required("NTT_PREFIX"),
      balance: nearToYocto(required("NTT_BALANCE") as `${number}`),
      wasmPath: resolve(required("NTT_WASM")),
      token: required("TOKEN_NEAR"),
      core: required("WORMHOLE_CORE_NEAR"),
      outboundLimit: required("NEAR_OUTBOUND_LIMIT"),
    });
  },
};

export default step;
