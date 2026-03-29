import { pad } from "viem";

import type { MigrationStep } from "../../types";
import { setAuthorizedEmitter } from "../../actions/basejump/setAuthorizedEmitter";

const step: MigrationStep = {
  name: "set-emitter",
  description: "Register BasejumpProxy as authorized emitter on Basejump",
  action: async (ctx) => {
    const bridgeAddress = ctx.outputs["deploy-bridge"].proxyAddress;
    const bridgeProxyAddress = ctx.ref("basejump-proxy", "deploy-bridge-proxy").proxyAddress;

    return await setAuthorizedEmitter({
      ...ctx.wallet,
      basejumpAddress: bridgeAddress as `0x${string}`,
      emitterChain: 16,
      emitter: pad(bridgeProxyAddress as `0x${string}`, { size: 32 }),
    });
  },
};

export default step;
