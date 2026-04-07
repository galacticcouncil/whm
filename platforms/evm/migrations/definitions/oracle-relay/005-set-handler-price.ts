import type { MigrationStep } from "../../types";
import { setHandler } from "../../actions/dispatcher/setHandler";

/**
 * Wire dispatcher → transactor: ACTION_ORACLE_PRICE (1) routes to the transactor.
 */
const step: MigrationStep = {
  name: "set-handler-price",
  description: "Map ACTION_ORACLE_PRICE (1) → transactor on dispatcher",
  action: async (ctx) => {
    const dispatcherAddress = ctx.outputs["deploy-dispatcher"].proxyAddress;
    const transactorAddress = ctx.outputs["deploy-transactor"].proxyAddress;

    return await setHandler({
      ...ctx.wallet,
      dispatcherAddress: dispatcherAddress as `0x${string}`,
      actionId: 1,
      handler: transactorAddress as `0x${string}`,
    });
  },
};

export default step;
