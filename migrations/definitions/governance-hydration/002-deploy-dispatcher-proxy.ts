import { getAddress, isAddress } from "viem";

import { deployDispatcherProxy } from "../../actions/governance/deploy";
import type { MigrationStep } from "./types";

const step: MigrationStep = {
  name: "002-deploy-dispatcher-proxy",
  description: "Deploy and atomically initialize GovernanceDispatcher proxy on Hydration",
  action: async (ctx) => {
    const required = (key: string) => {
      const value = ctx.env[key];
      if (!value) throw new Error(`Missing ${key}`);
      return value;
    };

    const implAddress = ctx.outputs["001-deploy-dispatcher-implementation"].implAddress;
    const wormholeCore = required("WORMHOLE_CORE_HYDRATION");
    const governanceCaller = required("GOVERNANCE_CALLER_HYDRATION");
    if (!isAddress(implAddress)) throw new Error(`Invalid dispatcher implementation: ${implAddress}`);
    if (!isAddress(wormholeCore)) throw new Error(`Invalid WORMHOLE_CORE_HYDRATION: ${wormholeCore}`);
    if (!isAddress(governanceCaller)) {
      throw new Error(`Invalid GOVERNANCE_CALLER_HYDRATION: ${governanceCaller}`);
    }

    return deployDispatcherProxy({
      ...ctx.wallet.hydration,
      implAddress: getAddress(implAddress),
      wormholeCore: getAddress(wormholeCore),
      expectedWormholeId: Number(required("WORMHOLE_ID_HYDRATION")),
      governanceCaller: getAddress(governanceCaller),
    });
  },
};

export default step;
