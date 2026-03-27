import { pad } from "viem";

import type { MigrationStep } from "../../types";
import { setAuthorizedEmitter } from "../../actions/instaBridge/setAuthorizedEmitter";

const step: MigrationStep = {
  name: "set-emitter",
  description: "Register InstaBridge as authorized emitter on InstaBridgeProxy",
  action: async (ctx) => {
    const bridgeProxyAddress = ctx.outputs["deploy-bridge-proxy"].proxyAddress;
    const { proxyAddress: bridgeAddress, wormholeId } = ctx.ref("insta-bridge", "deploy-bridge");

    return await setAuthorizedEmitter({
      ...ctx.wallet,
      instaBridgeAddress: bridgeProxyAddress as `0x${string}`,
      emitterChain: Number(wormholeId),
      emitter: pad(bridgeAddress as `0x${string}`, { size: 32 }),
    });
  },
};

export default step;
