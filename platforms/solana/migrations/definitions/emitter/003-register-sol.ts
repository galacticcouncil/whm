import type { MigrationStep } from "../../types";
import { registerPriceFeed } from "../../actions/emitter/registerPriceFeed";

const step: MigrationStep = {
  name: "register-sol",
  description: "Register SOL price feed on emitter",
  action: async (ctx) => {
    const assetId = ctx.env.SOL_ASSET_ID;
    const priceIndex = ctx.env.SOL_PRICE_INDEX;
    if (!assetId) throw new Error("Missing SOL_ASSET_ID");
    if (!priceIndex) throw new Error("Missing SOL_PRICE_INDEX");

    return await registerPriceFeed({
      ...ctx.wallet,
      assetId,
      priceIndex: Number(priceIndex),
    });
  },
};

export default step;
