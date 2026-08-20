import type { MigrationStep } from "./types";
import { transferAdmin } from "../../actions/psm/transferAdmin";

const step: MigrationStep = {
  name: "008-transfer-ownership@facilitator",
  description: "Hand facilitator DEFAULT_ADMIN_ROLE to its permanent holder, drop the deployer's",
  action: async (ctx) => {
    const facilitator = ctx.outputs["001-deploy-facilitator"].proxyAddress;
    const newAdmin = ctx.env.FACILITATOR_NEW_OWNER;
    if (!newAdmin) throw new Error("Missing FACILITATOR_NEW_OWNER");

    return await transferAdmin({
      ...ctx.wallet.hydration,
      contract: facilitator as `0x${string}`,
      newAdmin: newAdmin as `0x${string}`,
    });
  },
};

export default step;
