import { pad } from "viem";

import type { MigrationStep } from "../../types";
import { setAuthorizedEmitter } from "../../actions/basejump/setAuthorizedEmitter";

const step: MigrationStep = {
  name: "set-emitter",
  description: "Register Basejump as authorized emitter on BasejumpProxy",
  action: async (ctx) => {
    const bridgeProxyAddress = ctx.outputs["deploy-bridge-proxy"].proxyAddress;
    const { proxyAddress: bridgeAddress, wormholeId } = ctx.ref("basejump", "deploy-bridge");

    return await setAuthorizedEmitter({
      ...ctx.wallet,
      basejumpAddress: bridgeProxyAddress as `0x${string}`,
      emitterChain: Number(wormholeId),
      emitter: pad(bridgeAddress as `0x${string}`, { size: 32 }),
    });
  },
};

export default step;
