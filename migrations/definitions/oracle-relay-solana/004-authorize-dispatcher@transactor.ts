import type { MigrationStep } from "./types";
import { setAuthorized } from "../../actions/xcm-transactor/setAuthorized";

const step: MigrationStep = {
  name: "004-authorize-dispatcher@transactor",
  description: "Grant OracleDispatcher authorization on XcmTransactor",
  action: async (ctx) => {
    const transactorAddress = ctx.outputs["003-deploy-transactor"].proxyAddress;
    const dispatcherAddress = ctx.outputs["002-deploy-dispatcher"].proxyAddress;

    return await setAuthorized({
      ...ctx.wallet.moonbeam,
      transactorAddress: transactorAddress as `0x${string}`,
      operator: dispatcherAddress as `0x${string}`,
      enabled: true,
    });
  },
};

export default step;
