import type { MigrationStep } from "./types";
import { acceptOwnership } from "../../actions/near-ntt/acceptOwnership";

const step: MigrationStep = {
  name: "015-accept-ownership@router",
  description: "Complete the router's handover — stops until the DAO has accepted",
  action: async (ctx) => {
    const newOwner = ctx.env.ROUTER_NEW_OWNER;
    if (!newOwner) throw new Error("Missing ROUTER_NEW_OWNER");

    return await acceptOwnership({
      ...ctx.wallet.near,
      nttAccount: ctx.outputs["003-deploy-router"].routerAccount,
      newOwner,
    });
  },
};

export default step;
