import type { MigrationStep } from "./types";
import { setUtxoRoute } from "../../actions/intent-router/utxo-route";

const step: MigrationStep = {
  name: "013-set-zec-utxo-route@router",
  description: "Route the router's ZEC withdrawals to transparent addresses through withdraw-zec",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };
    return await setUtxoRoute({
      ...ctx.wallet.near,
      router: ctx.outputs["003-deploy-router"].routerAccount,
      token: required("ZEC_ASSET_NEAR"),
      route: {
        withdraw: required("ZEC_UTXO_WITHDRAW"),
        path_prefix: required("ZEC_UTXO_PATH_PREFIX"),
        address_prefixes: required("ZEC_UTXO_ADDRESS_PREFIXES").split(",").map((p) => p.trim()),
        min_amount: required("ZEC_UTXO_MIN_AMOUNT"),
      },
      sampleAddress: required("ZEC_UTXO_SAMPLE_ADDRESS"),
    });
  },
};

export default step;
