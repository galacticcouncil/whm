import type { MigrationStep } from "./types";
import { setOwner } from "../../actions/setOwner";

const step: MigrationStep = {
  name: "014-transfer-ownership@landing",
  description: "Transfer BasejumpLanding ownership on Hydration",
  action: async (ctx) => {
    const contract = ctx.outputs["004-deploy-landing"].proxyAddress;
    const newOwner = ctx.env.LANDING_NEW_OWNER;
    if (!newOwner) throw new Error("Missing LANDING_NEW_OWNER");

    return await setOwner({
      ...ctx.wallet.hydration,
      contract: contract as `0x${string}`,
      newOwner: newOwner as `0x${string}`,
    });
  },
};

export default step;
