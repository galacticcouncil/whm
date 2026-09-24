import type { MigrationStep } from "./types";
import { registerStorage } from "../../actions/near-ntt/registerStorage";

const step: MigrationStep = {
  name: "003-register-storage@token",
  description: "Register the NTT contract's storage on the token, so it can hold custody",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    return await registerStorage({
      ...ctx.wallet.near,
      token: required("TOKEN_NEAR"),
      nttAccount: ctx.outputs["001-deploy-ntt"].nttAccount,
    });
  },
};

export default step;
