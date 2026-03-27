import type { MigrationStep } from "../../types";
import { setXcmTransactor } from "../../actions/instaBridge/setXcmTransactor";

const step: MigrationStep = {
  name: "set-xcm-transactor",
  description: "Set XCM transactor address on InstaBridgeProxy",
  action: async (ctx) => {
    const bridgeProxyAddress = ctx.outputs["deploy-bridge-proxy"].proxyAddress;
    const transactorAddress = ctx.outputs["deploy-transactor"].proxyAddress;

    return await setXcmTransactor({
      ...ctx.wallet,
      instaBridgeProxyAddress: bridgeProxyAddress as `0x${string}`,
      xcmTransactor: transactorAddress as `0x${string}`,
    });
  },
};

export default step;
