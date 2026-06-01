import type { MigrationStep } from "../../types";
import { setAuthorized } from "../../actions/transactor/setAuthorized";

const step: MigrationStep = {
  name: "authorize-dispatcher",
  description: "Grant dispatcher authorization on transactor",
  action: async (ctx) => {
    const transactorAddress = ctx.outputs["deploy-transactor"].proxyAddress;
    const dispatcherAddress = ctx.outputs["deploy-dispatcher"].proxyAddress;

    return await setAuthorized({
      ...ctx.wallet,
      transactorAddress: transactorAddress as `0x${string}`,
      operator: dispatcherAddress as `0x${string}`,
      enabled: true,
    });
  },
};

export default step;
