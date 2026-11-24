import type { MigrationStep } from "./types";
import { acceptOwnership } from "../../actions/near-ntt/acceptOwnership";

const step: MigrationStep = {
  name: "005-accept-ownership@router",
  description: "Complete the router's handover — stops until the DAO has accepted",
  action: async (ctx) => {
    const router = ctx.env.NEAR_ROUTER;
    if (!router) throw new Error("Missing NEAR_ROUTER");
    const newOwner = ctx.env.ROUTER_NEW_OWNER;
    if (!newOwner) throw new Error("Missing ROUTER_NEW_OWNER");

    return await acceptOwnership({
      ...ctx.wallet.near,
      nttAccount: router,
      newOwner,
    });
  },
};

export default step;
