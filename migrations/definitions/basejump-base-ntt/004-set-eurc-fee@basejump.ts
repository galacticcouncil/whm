import type { MigrationStep } from "./types";
import { setAssetFee } from "../../actions/basejump/setAssetFee";

const step: MigrationStep = {
  name: "004-set-eurc-fee@basejump",
  description: "Set the per-transfer EURC fee retained by the landing",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    return await setAssetFee({
      ...ctx.wallet.base,
      basejumpAddress: ctx.outputs["001-deploy-basejump"].proxyAddress as `0x${string}`,
      asset: required("EURC_SOURCE_ASSET") as `0x${string}`,
      fee: BigInt(required("EURC_FEE_AMOUNT")),
    });
  },
};

export default step;
