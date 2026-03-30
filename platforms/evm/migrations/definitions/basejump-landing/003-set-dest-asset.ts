import type { MigrationStep } from "../../types";
import { setDestAsset } from "../../actions/basejumpLanding/setDestAsset";

const step: MigrationStep = {
  name: "set-dest-asset",
  description: "Configure asset mappings on BasejumpLanding",
  action: async (ctx) => {
    const basejumpLandingAddress = ctx.outputs["deploy"].proxyAddress;
    
    // Parse asset mappings from env (format: SOURCE_ASSET_1=0x...,DEST_ASSET_1=0x...)
    const sourceAsset = ctx.env.SOURCE_ASSET;
    const destAsset = ctx.env.DEST_ASSET;
    
    if (!sourceAsset || !destAsset) {
      console.log("  ⚠️  No asset mapping configured (SOURCE_ASSET/DEST_ASSET not set)");
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
