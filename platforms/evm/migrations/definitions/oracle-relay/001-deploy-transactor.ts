import type { MigrationStep } from "../../types";
import { deployTransactor } from "../../actions/transactor/deploy";

const step: MigrationStep = {
  name: "deploy-transactor",
  description: "Deploy XcmTransactor implementation + UUPS proxy",
  action: async (ctx) => {
    const env = ctx.env;
    const required = (key: string) => {
      if (!env[key]) throw new Error(`Missing ${key}`);
      return env[key];
    };

    return await deployTransactor({
      ...ctx.wallet,
      destinationParaId: Number(required("DESTINATION_PARA_ID")),
      sourceParaId: Number(required("SOURCE_PARA_ID")),
      evmPalletIndex: Number(required("EVM_PALLET_INDEX")),
      evmCallIndex: Number(required("EVM_CALL_INDEX")),
      feeAsset: required("FEE_ASSET") as `0x${string}`,
    });
  },
};

export default step;
