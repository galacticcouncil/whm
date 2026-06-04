import type { MigrationStep } from "./types";
import { setHandler } from "../../actions/oracle-dispatcher/setHandler";

const step: MigrationStep = {
  name: "009-set-handler-price@dispatcher",
  description: "Map ACTION_ORACLE_PRICE (1) → transactor on dispatcher",
  action: async (ctx) => {
    const dispatcherAddress = ctx.outputs["002-deploy-dispatcher"].proxyAddress;
    const transactorAddress = ctx.outputs["003-deploy-transactor"].proxyAddress;

    return await setHandler({
      ...ctx.wallet.moonbeam,
      dispatcherAddress: dispatcherAddress as `0x${string}`,
      actionId: 1,
      handler: transactorAddress as `0x${string}`,
    });
  },
};

export default step;
