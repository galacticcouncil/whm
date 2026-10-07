import { getAddress, isAddress } from "viem";

import { deployExecutorProxy } from "../../actions/governance/deploy";
import type { MigrationStep } from "./types";

const step: MigrationStep = {
  name: "004-deploy-executor-proxy",
  description: "Deploy and atomically initialize GovernanceExecutor proxy on Robinhood",
  action: async (ctx) => {
    const required = (key: string) => {
      const value = ctx.env[key];
      if (!value) throw new Error(`Missing ${key}`);
      return value;
    };

    const implAddress = ctx.outputs["003-deploy-executor-implementation"].implAddress;
    const sourceDispatcher = ctx.outputs["002-deploy-dispatcher-proxy"].proxyAddress;
    const wormholeCore = required("WORMHOLE_CORE_ROBINHOOD");
    const vetoer = required("ROBINHOOD_TC_SAFE");
    if (!isAddress(implAddress)) throw new Error(`Invalid executor implementation: ${implAddress}`);
    if (!isAddress(sourceDispatcher)) throw new Error(`Invalid source dispatcher: ${sourceDispatcher}`);
    if (!isAddress(wormholeCore)) throw new Error(`Invalid WORMHOLE_CORE_ROBINHOOD: ${wormholeCore}`);
    if (!isAddress(vetoer)) throw new Error(`Invalid ROBINHOOD_TC_SAFE: ${vetoer}`);

    return deployExecutorProxy({
      ...ctx.wallet.robinhood,
      implAddress: getAddress(implAddress),
      wormholeCore: getAddress(wormholeCore),
      expectedWormholeId: Number(required("WORMHOLE_ID_ROBINHOOD")),
      sourceDispatcher: getAddress(sourceDispatcher),
      vetoer: getAddress(vetoer),
      expectedVetoerThreshold: Number(required("ROBINHOOD_TC_THRESHOLD")),
      expectedVetoerOwnerCount: Number(required("ROBINHOOD_TC_OWNER_COUNT")),
      vetoPeriod: Number(required("VETO_PERIOD_SECONDS")),
      executionGracePeriod: Number(required("EXECUTION_GRACE_PERIOD_SECONDS")),
    });
  },
};

export default step;
