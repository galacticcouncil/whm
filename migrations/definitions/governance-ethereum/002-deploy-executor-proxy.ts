import { getAddress, isAddress, zeroAddress } from "viem";

import { deployExecutorProxy } from "../../actions/governance/deploy";
import type { MigrationStep } from "./types";

const step: MigrationStep = {
  name: "002-deploy-executor-proxy",
  description: "Deploy and atomically initialize GovernanceExecutor proxy on Ethereum",
  action: async (ctx) => {
    const required = (key: string) => {
      const value = ctx.env[key];
      if (!value) throw new Error(`Missing ${key}`);
      return value;
    };

    const implAddress = ctx.outputs["001-deploy-executor-implementation"].implAddress;
    const sourceDispatcher = required("GOVERNANCE_DISPATCHER_HYDRATION");
    const wormholeCore = required("WORMHOLE_CORE_ETHEREUM");
    const vetoer = required("ETHEREUM_TC_SAFE");
    if (!isAddress(implAddress)) throw new Error(`Invalid executor implementation: ${implAddress}`);
    if (!isAddress(sourceDispatcher) || getAddress(sourceDispatcher) === zeroAddress) {
      throw new Error(`Invalid GOVERNANCE_DISPATCHER_HYDRATION: ${sourceDispatcher}`);
    }
    if (!isAddress(wormholeCore)) throw new Error(`Invalid WORMHOLE_CORE_ETHEREUM: ${wormholeCore}`);
    if (!isAddress(vetoer)) throw new Error(`Invalid ETHEREUM_TC_SAFE: ${vetoer}`);

    return deployExecutorProxy({
      ...ctx.wallet.ethereum,
      implAddress: getAddress(implAddress),
      wormholeCore: getAddress(wormholeCore),
      expectedWormholeId: Number(required("WORMHOLE_ID_ETHEREUM")),
      sourceDispatcher: getAddress(sourceDispatcher),
      vetoer: getAddress(vetoer),
      expectedVetoerThreshold: Number(required("ETHEREUM_TC_THRESHOLD")),
      expectedVetoerOwnerCount: Number(required("ETHEREUM_TC_OWNER_COUNT")),
      vetoPeriod: Number(required("VETO_PERIOD_SECONDS")),
      executionGracePeriod: Number(required("EXECUTION_GRACE_PERIOD_SECONDS")),
    });
  },
};

export default step;
