import type { MigrationStep } from "./types";
import { setOwner } from "../../actions/setOwner";

const step: MigrationStep = {
  name: "009-transfer-ownership@basejump",
  description: "Transfer ownership to the Base Technical Committee Safe",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    return await setOwner({
      ...ctx.wallet.base,
      contract: ctx.outputs["001-deploy-basejump"].proxyAddress as `0x${string}`,
      newOwner: required("BASE_TC_SAFE") as `0x${string}`,
    });
  },
};

export default step;
