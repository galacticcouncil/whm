import type { MigrationStep } from "../../types";
import { setDestAsset } from "../../actions/basejumpLanding/setDestAsset";

const step: MigrationStep = {
  name: "set-dest-asset_EURC",
  description: "Configure asset mappings on BasejumpLanding",
  action: async (ctx) => {
    const basejumpLandingAddress = ctx.outputs["deploy"].proxyAddress;

    const sourceAsset = ctx.env.EURC_SOURCE_ASSET;
    const destAsset = ctx.env.EURC_DEST_ASSET;

    if (!sourceAsset || !destAsset) {
      console.log("  ⚠️  No asset mapping configured");
      return {}; // Skip if not configured
    }

    return await setDestAsset({
      ...ctx.wallet,
      basejumpLandingAddress: basejumpLandingAddress as `0x${string}`,
      sourceAsset: sourceAsset as `0x${string}`,
      destAsset: destAsset as `0x${string}`,
    });
  },
};

export default step;
