import type { MigrationStep } from "./types";
import { acceptOwnership } from "../../actions/near-ntt/acceptOwnership";

const step: MigrationStep = {
  name: "007-accept-ownership@ntt",
  description: "Complete the ownership handover — accepts if the custodian is the deployer, else waits for it",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    return await acceptOwnership({
      ...ctx.wallet.near,
      nttAccount: ctx.outputs["001-deploy-ntt"].nttAccount,
      newOwner: required("NTT_NEW_OWNER"),
    });
  },
};

export default step;
