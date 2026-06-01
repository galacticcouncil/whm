import type { MigrationStep } from "../../solana";
import { registerPriceFeed } from "../../actions/oracle-emitter-solana/registerPriceFeed";

const step: MigrationStep = {
  name: "register-prime",
  description: "Register PRIME price feed on emitter",
  action: async (ctx) => {
    const assetId = ctx.env.PRIME_ASSET_ID;
    const priceIndex = ctx.env.PRIME_PRICE_INDEX;
    const scopePrices = ctx.env.SCOPE_ORACLE_PRICES;
    if (!assetId) throw new Error("Missing PRIME_ASSET_ID");
    if (!priceIndex) throw new Error("Missing PRIME_PRICE_INDEX");
    if (!scopePrices) throw new Error("Missing SCOPE_ORACLE_PRICES");

    return await registerPriceFeed({
      ...ctx.wallet,
      assetId,
      priceIndex: Number(priceIndex),
      scopePrices,
    });
  },
};

export default step;
