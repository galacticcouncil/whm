import { pad } from "viem";

import type { MigrationStep } from "../../types";
import { setAuthorizedEmitter } from "../../actions/basejump/setAuthorizedEmitter";

const step: MigrationStep = {
  name: "set-emitter",
  description: "Register BasejumpProxy as authorized emitter on Basejump",
  action: async (ctx) => {
    const proxyEnv = ctx.env.PROXY_ENV;
    if (!proxyEnv) throw new Error("Missing PROXY_ENV");

    const basejumpAddress = ctx.outputs["deploy"].proxyAddress;
    const emitterAddress = ctx.ref("basejump-proxy", "deploy-proxy", proxyEnv).proxyAddress;

    return await setAuthorizedEmitter({
      ...ctx.wallet,
      basejumpAddress: basejumpAddress as `0x${string}`,
      emitterChain: 16,
      emitter: pad(emitterAddress as `0x${string}`, { size: 32 }),
    });
  },
};

export default step;
