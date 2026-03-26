import type { MigrationStep } from "../../types";
import { setAuthorized } from "../../actions/transactor/setAuthorized";

/**
 * Authorize the dispatcher to call transact() on the transactor.
 * Uses outputs from steps 001 (transactor proxy) and 002 (dispatcher proxy).
 */
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
