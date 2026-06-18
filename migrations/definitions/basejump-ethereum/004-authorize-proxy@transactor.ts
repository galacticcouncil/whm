import type { MigrationStep } from "./types";
import { setAuthorized } from "../../actions/xcm-transactor/setAuthorized";

const step: MigrationStep = {
  name: "004-authorize-proxy@transactor",
  description: "Grant BasejumpProxy authorization on XcmTransactor",
  action: async (ctx) => {
    const transactorAddress = ctx.outputs["003-deploy-transactor"].proxyAddress;
    const proxyAddress = ctx.outputs["002-deploy-proxy"].proxyAddress;

    return await setAuthorized({
      ...ctx.wallet.moonbeam,
      transactorAddress: transactorAddress as `0x${string}`,
      operator: proxyAddress as `0x${string}`,
      enabled: true,
    });
  },
};

export default step;
