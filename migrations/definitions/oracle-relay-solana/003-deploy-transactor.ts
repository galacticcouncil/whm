import type { MigrationStep } from "./types";
import { deployTransactor } from "../../actions/xcm-transactor/deploy";

const step: MigrationStep = {
  name: "003-deploy-transactor",
  description: "Deploy XcmTransactor on Moonbeam",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    return await deployTransactor({
      ...ctx.wallet.moonbeam,
      destinationParaId: Number(required("DESTINATION_PARA_ID")),
      sourceParaId: Number(required("SOURCE_PARA_ID")),
      evmPalletIndex: Number(required("EVM_PALLET_INDEX")),
      evmCallIndex: Number(required("EVM_CALL_INDEX")),
      feeAsset: required("FEE_ASSET") as `0x${string}`,
    });
  },
};

export default step;
