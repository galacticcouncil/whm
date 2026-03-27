import { pad } from "viem";

import type { MigrationStep } from "../../types";
import { setAuthorizedEmitter } from "../../actions/instaBridge/setAuthorizedEmitter";

const step: MigrationStep = {
  name: "set-emitter",
  description: "Register InstaBridge as authorized emitter on InstaBridgeProxy",
  action: async (ctx) => {
    const env = ctx.env;
    const required = (key: string) => {
      if (!env[key]) throw new Error(`Missing ${key}`);
      return env[key];
    };

    const bridgeProxyAddress = ctx.outputs["deploy-bridge-proxy"].proxyAddress;
    const bridgeAddress = ctx.ref("insta-bridge", "deploy-bridge").proxyAddress;

    return await setAuthorizedEmitter({
      ...ctx.wallet,
      instaBridgeAddress: bridgeProxyAddress as `0x${string}`,
      emitterChain: Number(required("BASE_WH_CHAIN_ID")),
      emitter: pad(bridgeAddress as `0x${string}`, { size: 32 }),
    });
  },
};

export default step;
