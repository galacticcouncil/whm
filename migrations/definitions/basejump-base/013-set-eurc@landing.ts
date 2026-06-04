import type { MigrationStep } from "./types";
import { setDestAsset } from "../../actions/basejump-landing/setDestAsset";

const step: MigrationStep = {
  name: "013-set-eurc@landing",
  description: "Configure EURC source→dest mapping on BasejumpLanding (Hydration)",
  action: async (ctx) => {
    const basejumpLandingAddress = ctx.outputs["004-deploy-landing"].proxyAddress;
    const sourceAsset = ctx.env.EURC_SOURCE_ASSET;
    const destAsset = ctx.env.EURC_DEST_ASSET;

    if (!sourceAsset || !destAsset) {
      console.log("  ⚠️  No EURC asset mapping configured, skipping");
      return {};
    }

    return await setDestAsset({
      ...ctx.wallet.hydration,
      basejumpLandingAddress: basejumpLandingAddress as `0x${string}`,
      sourceAsset: sourceAsset as `0x${string}`,
      destAsset: destAsset as `0x${string}`,
    });
  },
};

export default step;
