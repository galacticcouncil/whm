import type { MigrationStep } from "./types";
import { registerEmitter } from "../../actions/near-ntt/registerEmitter";

const step: MigrationStep = {
  name: "002-register-emitter@core",
  description: "Register the NTT contract as a Wormhole emitter",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    return await registerEmitter({
      ...ctx.wallet.near,
      core: required("WORMHOLE_CORE_NEAR"),
      nttAccount: ctx.outputs["001-deploy-ntt"].nttAccount,
    });
  },
};

export default step;
