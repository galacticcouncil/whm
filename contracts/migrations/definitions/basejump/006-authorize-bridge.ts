import type { MigrationStep } from "../../types";
import { setAuthorizedBridge } from "../../actions/basejumpLanding/setAuthorizedBridge";

const step: MigrationStep = {
  name: "authorize-bridge",
  description: "Authorize Basejump on BasejumpLanding",
  action: async (ctx) => {
    const basejumpLandingAddress = ctx.outputs["deploy-landing"]?.proxyAddress;
    if (!basejumpLandingAddress) return {}; // No Landing, skip

    const bridgeAddress = ctx.outputs["deploy"].proxyAddress;

    return await setAuthorizedBridge({
      ...ctx.wallet,
      basejumpLandingAddress: basejumpLandingAddress as `0x${string}`,
      bridgeAddress: bridgeAddress as `0x${string}`,
      enabled: true,
    });
  },
};

export default step;
