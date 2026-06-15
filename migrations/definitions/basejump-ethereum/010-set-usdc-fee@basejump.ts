import type { MigrationStep } from "./types";
import { setAssetFee } from "../../actions/basejump/setAssetFee";

const step: MigrationStep = {
  name: "010-set-usdc-fee@basejump",
  description: "Configure USDC asset fee on Basejump",
  action: async (ctx) => {
    const basejumpAddress = ctx.outputs["001-deploy-basejump"].proxyAddress;
    const asset = ctx.env.USDC_FEE_ASSET;
    const feeStr = ctx.env.USDC_FEE_AMOUNT;

    if (!asset || !feeStr) {
      console.log("  ⚠️  No USDC fee configured, skipping");
      return {};
    }

    return await setAssetFee({
      ...ctx.wallet.ethereum,
      basejumpAddress: basejumpAddress as `0x${string}`,
      asset: asset as `0x${string}`,
      fee: BigInt(feeStr),
    });
  },
};

export default step;
