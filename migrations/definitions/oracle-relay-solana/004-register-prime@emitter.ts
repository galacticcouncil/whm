import type { MigrationStep } from "./types";
import { registerPriceFeed } from "../../actions/oracle-emitter-solana/registerPriceFeed";

const step: MigrationStep = {
  name: "004-register-prime@emitter",
  description: "Register PRIME price feed on Solana oracle emitter",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    return await registerPriceFeed({
      ...ctx.wallet.solana,
      assetId: required("PRIME_ASSET_ID"),
      priceIndex: Number(required("PRIME_PRICE_INDEX")),
      scopePrices: required("SCOPE_ORACLE_PRICES"),
    });
  },
};

export default step;
