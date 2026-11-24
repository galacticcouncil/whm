import type { MigrationStep } from "./types";
import { transferOwnership } from "../../actions/near-ntt/transferOwnership";

const step: MigrationStep = {
  name: "014-transfer-ownership@router",
  description: "Propose the NEAR DAO as the router's owner",
  action: async (ctx) => {
    const newOwner = ctx.env.ROUTER_NEW_OWNER;
    if (!newOwner) throw new Error("Missing ROUTER_NEW_OWNER");

    // The router's two-step ownership is the NTT manager's: the same action serves both.
    return await transferOwnership({
      ...ctx.wallet.near,
      nttAccount: ctx.outputs["003-deploy-router"].routerAccount,
      newOwner,
    });
  },
};

export default step;
