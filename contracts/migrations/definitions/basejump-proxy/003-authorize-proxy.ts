import type { MigrationStep } from "../../types";
import { setAuthorized } from "../../actions/transactor/setAuthorized";

const step: MigrationStep = {
  name: "authorize-proxy",
  description: "Grant BasejumpProxy authorization on XcmTransactor",
  action: async (ctx) => {
    const transactorAddress = ctx.outputs["deploy-transactor"].proxyAddress;
    const proxyAddress = ctx.outputs["deploy-proxy"].proxyAddress;

    return await setAuthorized({
      ...ctx.wallet,
      transactorAddress: transactorAddress as `0x${string}`,
      operator: proxyAddress as `0x${string}`,
      enabled: true,
    });
  },
};

export default step;
