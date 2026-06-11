import type { MigrationStep } from "./types";
import { setAuthorizedBridge } from "../../actions/basejump-landing-native/setAuthorizedBridge";

const step: MigrationStep = {
  name: "005-authorize-basejump@landing",
  description: "Authorize Ethereum Basejump as a bridge on BasejumpLandingNative",
  action: async (ctx) => {
    const basejumpLandingAddress = ctx.outputs["003-deploy-landing"].proxyAddress;
    const basejumpAddress = ctx.outputs["002-deploy-basejump"].proxyAddress;

    return await setAuthorizedBridge({
      ...ctx.wallet.ethereum,
      basejumpLandingAddress: basejumpLandingAddress as `0x${string}`,
      bridgeAddress: basejumpAddress as `0x${string}`,
      enabled: true,
    });
  },
};

export default step;
