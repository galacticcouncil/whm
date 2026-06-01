import { pad } from "viem";

import type { MigrationStep } from "../../types";
import { setAuthorizedEmitter } from "../../actions/basejump/setAuthorizedEmitter";

const step: MigrationStep = {
  name: "set-emitter",
  description: "Register source chain Basejump as authorized emitter on BasejumpProxy",
  action: async (ctx) => {
    const proxyEnv = ctx.env.PROXY_ENV;
    if (!proxyEnv) throw new Error("Missing PROXY_ENV");

    const proxyAddress = ctx.ref("basejump-proxy", "deploy-proxy", proxyEnv).proxyAddress;
    const { proxyAddress: basejumpAddress, wormholeId } = ctx.ref("basejump", "deploy");

    return await setAuthorizedEmitter({
      ...ctx.wallet,
      basejumpAddress: proxyAddress as `0x${string}`,
      emitterChain: Number(wormholeId),
      emitter: pad(basejumpAddress as `0x${string}`, { size: 32 }),
    });
  },
};

export default step;
