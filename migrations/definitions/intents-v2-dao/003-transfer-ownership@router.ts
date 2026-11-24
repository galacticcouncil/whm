import type { MigrationStep } from "./types";
import { transferOwnership } from "../../actions/near-ntt/transferOwnership";

const step: MigrationStep = {
  name: "003-transfer-ownership@router",
  description: "Propose the NEAR DAO as the router's owner",
  action: async (ctx) => {
    const router = ctx.env.NEAR_ROUTER;
    if (!router) throw new Error("Missing NEAR_ROUTER");
    const newOwner = ctx.env.ROUTER_NEW_OWNER;
    if (!newOwner) throw new Error("Missing ROUTER_NEW_OWNER");

    // The router's two-step ownership is the NTT manager's: the same action serves both.
    return await transferOwnership({
      ...ctx.wallet.near,
      nttAccount: router,
      newOwner,
    });
  },
};

export default step;
