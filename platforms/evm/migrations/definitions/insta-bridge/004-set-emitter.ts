import { pad } from "viem";

import type { MigrationStep } from "../../types";
import { setAuthorizedEmitter } from "../../actions/instaBridge/setAuthorizedEmitter";

const step: MigrationStep = {
  name: "set-emitter",
  description: "Register InstaBridgeProxy as authorized emitter on InstaBridge",
  action: async (ctx) => {
    const env = ctx.env;
    const required = (key: string) => {
      if (!env[key]) throw new Error(`Missing ${key}`);
      return env[key];
    };

    const bridgeAddress = ctx.outputs["deploy-bridge"].proxyAddress;
    const bridgeProxyAddress = ctx.ref(
      "insta-bridge-proxy",
      "deploy-bridge-proxy",
      //required("REF_PROXY_ENV"),
    ).proxyAddress;

    return await setAuthorizedEmitter({
      ...ctx.wallet,
      instaBridgeAddress: bridgeAddress as `0x${string}`,
      emitterChain: 16,
      emitter: pad(bridgeProxyAddress as `0x${string}`, { size: 32 }),
    });
  },
};

export default step;
