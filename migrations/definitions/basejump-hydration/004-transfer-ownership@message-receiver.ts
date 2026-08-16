import type { MigrationStep } from "./types";
import { setOwner } from "../../actions/setOwner";

const step: MigrationStep = {
  name: "004-transfer-ownership@message-receiver",
  description: "Transfer Hydration receiver ownership to the Technical Committee",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    return await setOwner({
      ...ctx.wallet.hydration,
      contract: ctx.outputs["001-deploy-message-receiver"].proxyAddress as `0x${string}`,
      newOwner: required("MESSAGE_RECEIVER_NEW_OWNER") as `0x${string}`,
    });
  },
};

export default step;
