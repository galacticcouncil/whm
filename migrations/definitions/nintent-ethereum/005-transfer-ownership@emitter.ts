import type { MigrationStep } from "./types";
import { setOwner } from "../../actions/setOwner";

const step: MigrationStep = {
  name: "014-transfer-ownership@landing",
  description: "Transfer IntentEmitter ownership on Hydration",
  action: async (ctx) => {
    const contract = ctx.outputs["001-deploy-emitter"].proxyAddress;
    const newOwner = ctx.env.EMITTER_NEW_OWNER;
    if (!newOwner) throw new Error("Missing EMITTER_NEW_OWNER");

    return await setOwner({
      ...ctx.wallet.hydration,
      contract: contract as `0x${string}`,
      newOwner: newOwner as `0x${string}`,
    });
  },
};

export default step;
