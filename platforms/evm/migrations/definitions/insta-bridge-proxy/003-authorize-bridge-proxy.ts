import type { MigrationStep } from "../../types";
import { setAuthorized } from "../../actions/transactor/setAuthorized";

const step: MigrationStep = {
  name: "authorize-bridge-proxy",
  description: "Grant InstaBridgeProxy authorization on XcmTransactor",
  action: async (ctx) => {
    const transactorAddress = ctx.outputs["deploy-transactor"].proxyAddress;
    const bridgeProxyAddress = ctx.outputs["deploy-bridge-proxy"].proxyAddress;

    return await setAuthorized({
      ...ctx.wallet,
      transactorAddress: transactorAddress as `0x${string}`,
      operator: bridgeProxyAddress as `0x${string}`,
      enabled: true,
    });
  },
};

export default step;
