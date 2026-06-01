import type { MigrationStep } from "../../types";
import { setAssetFee } from "../../actions/basejump/setAssetFee";

const step: MigrationStep = {
  name: "set-asset-fee_EURC",
  description: "Configure asset fees on Basejump",
  action: async (ctx) => {
    const basejumpAddress = ctx.outputs["deploy"].proxyAddress;

    const asset = ctx.env.EURC_FEE_ASSET;
    const feeStr = ctx.env.EURC_FEE_AMOUNT;

    if (!asset || !feeStr) {
      console.log("  ⚠️  No fee configured");
      return {}; // Skip if not configured
    }

    return await setAssetFee({
      ...ctx.wallet,
      basejumpAddress: basejumpAddress as `0x${string}`,
      asset: asset as `0x${string}`,
      fee: BigInt(feeStr),
    });
  },
};

export default step;
