import type { MigrationStep } from "./types";
import { setAssetFee } from "../../actions/basejump/setAssetFee";

const step: MigrationStep = {
  name: "012-set-eurc-fee@basejump",
  description: "Configure EURC asset fee on Basejump",
  action: async (ctx) => {
    const basejumpAddress = ctx.outputs["001-deploy-basejump"].proxyAddress;
    const asset = ctx.env.EURC_FEE_ASSET;
    const feeStr = ctx.env.EURC_FEE_AMOUNT;

    if (!asset || !feeStr) {
      console.log("  ⚠️  No EURC fee configured, skipping");
      return {};
    }

    return await setAssetFee({
      ...ctx.wallet.base,
      basejumpAddress: basejumpAddress as `0x${string}`,
      asset: asset as `0x${string}`,
      fee: BigInt(feeStr),
    });
  },
};

export default step;
