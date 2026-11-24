import { isAddress } from "viem";

import type { MigrationStep } from "./types";
import { setOwner } from "../../actions/setOwner";

const step: MigrationStep = {
  name: "002-transfer-ownership@dispatcher",
  description: "Transfer Hydration dispatcher ownership to the Emergency Admin",
  action: async (ctx) => {
    const dispatcher = ctx.env.HYDRATION_DISPATCHER;
    if (!dispatcher || !isAddress(dispatcher)) throw new Error(`Missing or invalid HYDRATION_DISPATCHER: ${dispatcher}`);
    const newOwner = ctx.env.HYDRATION_EMERGENCY_ADMIN;
    if (!newOwner || !isAddress(newOwner)) {
      throw new Error(`Missing or invalid HYDRATION_EMERGENCY_ADMIN: ${newOwner}`);
    }

    // Price routes, minimums, the manager and forwarder, sweep and upgrades become TC calls.
    return await setOwner({
      ...ctx.wallet.hydration,
      contract: dispatcher as `0x${string}`,
      newOwner: newOwner as `0x${string}`,
    });
  },
};

export default step;
