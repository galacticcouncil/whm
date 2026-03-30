import type { MigrationStep } from "../../types";
import { setAssetFee } from "../../actions/basejump/setAssetFee";

const step: MigrationStep = {
  name: "set-asset-fee",
  description: "Configure asset fees on Basejump",
  action: async (ctx) => {
    const basejumpAddress = ctx.outputs["deploy"].proxyAddress;
    
    // Parse fee configuration from env (format: ASSET=0x...,FEE=1000000)
    const asset = ctx.env.FEE_ASSET;
    const feeStr = ctx.env.FEE_AMOUNT;
    
    if (!asset || !feeStr) {
      console.log("  ⚠️  No fee configured (FEE_ASSET/FEE_AMOUNT not set)");
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
