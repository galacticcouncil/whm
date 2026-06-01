import type { MigrationStep } from "../../types";
import { registerPoolFeed } from "../../actions/emitter/registerPoolFeed";

const step: MigrationStep = {
  name: "register-jitosol",
  description: "Register JitoSOL pool feed on emitter",
  action: async (ctx) => {
    const assetId = ctx.env.JITOSOL_ASSET_ID;
    const stakePool = ctx.env.JITOSOL_STAKE_POOL;
    if (!assetId) throw new Error("Missing JITOSOL_ASSET_ID");
    if (!stakePool) throw new Error("Missing JITOSOL_STAKE_POOL");

    return await registerPoolFeed({
      ...ctx.wallet,
      assetId,
      stakePool,
    });
  },
};

export default step;
