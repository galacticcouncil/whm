import type { MigrationStep } from "./types";
import { setAssetFee } from "../../actions/basejump/setAssetFee";

const step: MigrationStep = {
  name: "009-set-weth-fee@proxy",
  description: "Configure the WETH fast-path fee on the Moonbeam BasejumpProxy",
  action: async (ctx) => {
    const proxyAddress = ctx.outputs["001-deploy-proxy"].proxyAddress;
    const asset = ctx.env.WETH_FEE_ASSET;
    const feeStr = ctx.env.WETH_FEE_AMOUNT;

    if (!asset || !feeStr) {
      console.log("  ⚠️  No WETH fee configured, skipping");
      return {};
    }

    return await setAssetFee({
      ...ctx.wallet.moonbeam,
      basejumpAddress: proxyAddress as `0x${string}`,
      asset: asset as `0x${string}`,
      fee: BigInt(feeStr),
    });
  },
};

export default step;
