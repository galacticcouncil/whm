import type { MigrationStep } from "../../types";
import { registerAsset } from "../../actions/emitter/registerAsset";

const step: MigrationStep = {
  name: "register-prime",
  description: "Register PRIME price feed on emitter",
  action: async (ctx) => {
    const assetId = ctx.env.PRIME_ASSET_ID;
    const priceIndex = ctx.env.PRIME_PRICE_INDEX;
    if (!assetId) throw new Error("Missing PRIME_ASSET_ID");
    if (!priceIndex) throw new Error("Missing PRIME_PRICE_INDEX");

    return await registerAsset({
      ...ctx.wallet,
      assetId,
      priceIndex: Number(priceIndex),
    });
  },
};

export default step;
