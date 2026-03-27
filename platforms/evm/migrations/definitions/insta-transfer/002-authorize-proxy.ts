import type { MigrationStep } from "../../types";
import { setAuthorizedBridge } from "../../actions/instaTransfer/setAuthorizedBridge";

const step: MigrationStep = {
  name: "authorize-proxy",
  description: "Authorize InstaBridgeProxy Transactor MDA on InstaTransfer",
  action: async (ctx) => {
    const instaTransferAddress = ctx.outputs["deploy-transfer"].proxyAddress;
    const proxyTransactorMda = ctx.ref("insta-bridge-proxy", "deploy-transactor").mdaH160;

    return await setAuthorizedBridge({
      ...ctx.wallet,
      instaTransferAddress: instaTransferAddress as `0x${string}`,
      bridgeAddress: proxyTransactorMda as `0x${string}`,
      enabled: true,
    });
  },
};

export default step;
