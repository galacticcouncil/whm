import type { MigrationStep } from "./types";
import { setUtxoRoute } from "../../actions/intent-router/utxo-route";

const step: MigrationStep = {
  name: "014-set-btc-utxo-route@router",
  description: "Route the router's nBTC withdrawals through withdraw-btc",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };
    return await setUtxoRoute({
      ...ctx.wallet.near,
      router: ctx.outputs["003-deploy-router"].routerAccount,
      token: required("BTC_ASSET_NEAR"),
      route: {
        withdraw: required("BTC_UTXO_WITHDRAW"),
        path_prefix: required("BTC_UTXO_PATH_PREFIX"),
        address_prefixes: required("BTC_UTXO_ADDRESS_PREFIXES").split(",").map((p) => p.trim()),
        min_amount: required("BTC_UTXO_MIN_AMOUNT"),
      },
      sampleAddress: required("BTC_UTXO_SAMPLE_ADDRESS"),
    });
  },
};

export default step;
