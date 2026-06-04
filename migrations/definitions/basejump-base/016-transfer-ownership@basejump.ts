import type { MigrationStep } from "./types";
import { setOwner } from "../../actions/setOwner";

const step: MigrationStep = {
  name: "016-transfer-ownership@basejump",
  description: "Transfer Basejump ownership on source chain",
  action: async (ctx) => {
    const contract = ctx.outputs["001-deploy-basejump"].proxyAddress;
    const newOwner = ctx.env.BASEJUMP_NEW_OWNER;
    if (!newOwner) throw new Error("Missing BASEJUMP_NEW_OWNER");

    return await setOwner({
      ...ctx.wallet.base,
      contract: contract as `0x${string}`,
      newOwner: newOwner as `0x${string}`,
    });
  },
};

export default step;
