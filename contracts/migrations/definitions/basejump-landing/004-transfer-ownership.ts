import type { MigrationStep } from "../../types";
import { setOwner } from "../../actions/setOwner";

const step: MigrationStep = {
  name: "transfer-ownership",
  description: "Transfer BasejumpLanding ownership to Hydration TC",
  action: async (ctx) => {
    const contract = ctx.outputs["deploy"].proxyAddress;
    const newOwner = ctx.env.NEW_OWNER;
    if (!newOwner) throw new Error("Missing NEW_OWNER");

    return await setOwner({
      ...ctx.wallet,
      contract: contract as `0x${string}`,
      newOwner: newOwner as `0x${string}`,
    });
  },
};

export default step;
