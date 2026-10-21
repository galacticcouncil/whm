import type { MigrationStep } from "./types";
import { transferOwnership } from "../../actions/near-ntt/transferOwnership";

const step: MigrationStep = {
  name: "002-transfer-ownership@withdraw",
  description: "Propose the NEAR custodian as the withdraw contract's owner",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    // The near-ntt action works on any contract with the same two-step ownership.
    return await transferOwnership({
      ...ctx.wallet.near,
      nttAccount: ctx.outputs["001-deploy-withdraw"].withdrawAccount,
      newOwner: required("WITHDRAW_NEW_OWNER"),
    });
  },
};

export default step;
