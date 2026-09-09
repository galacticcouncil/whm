import { isAddress } from "viem";

import type { MigrationStep } from "./types";
import { setOwner } from "../../actions/setOwner";

const step: MigrationStep = {
  name: "008-transfer-ownership@emitter",
  description: "Transfer Hydration emitter ownership to the Emergency Admin",
  action: async (ctx) => {
    const newOwner = ctx.env.HYDRATION_EMERGENCY_ADMIN;
    if (!newOwner || !isAddress(newOwner)) {
      throw new Error(`Missing or invalid HYDRATION_EMERGENCY_ADMIN: ${newOwner}`);
    }

    // Last step of the migration. The entry point keeps its owner-only escape hatches — sweep,
    // setNttManager, setIntentReceiver, _authorizeUpgrade — so they become TC calls from here.
    return await setOwner({
      ...ctx.wallet.hydration,
      contract: ctx.outputs["001-deploy-emitter"].proxyAddress as `0x${string}`,
      newOwner: newOwner as `0x${string}`,
    });
  },
};

export default step;
