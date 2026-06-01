import type { MigrationStep } from "../../evm";
import { setHandler } from "../../actions/oracle-dispatcher/setHandler";

// Only ACTION_RATE_UPDATE (2) is wired. OracleEmitter on Ethereum is rate-only.
const step: MigrationStep = {
  name: "set-handler-rate",
  description: "Map ACTION_RATE_UPDATE (2) → transactor on dispatcher",
  action: async (ctx) => {
    const dispatcherAddress = ctx.outputs["deploy-dispatcher"].proxyAddress;
    const transactorAddress = ctx.outputs["deploy-transactor"].proxyAddress;

    return await setHandler({
      ...ctx.wallet,
      dispatcherAddress: dispatcherAddress as `0x${string}`,
      actionId: 2,
      handler: transactorAddress as `0x${string}`,
    });
  },
};

export default step;
