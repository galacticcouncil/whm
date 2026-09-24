import type { MigrationStep } from "./types";
import { transferOwnership } from "../../actions/near-ntt/transferOwnership";

const step: MigrationStep = {
  name: "005-transfer-ownership@ntt",
  description: "Transfer the NTT contract's ownership to the NEAR custodian",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    return await transferOwnership({
      ...ctx.wallet.near,
      nttAccount: ctx.outputs["001-deploy-ntt"].nttAccount,
      newOwner: required("NTT_NEW_OWNER"),
    });
  },
};

export default step;
