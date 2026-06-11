import { pad } from "viem";

import type { MigrationStep } from "./types";
import { setAuthorizedEmitter } from "../../actions/basejump/setAuthorizedEmitter";

const step: MigrationStep = {
  name: "006-set-emitter@basejump",
  description: "Register Moonbeam BasejumpProxy as authorized emitter on Ethereum Basejump",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    const basejumpAddress = ctx.outputs["002-deploy-basejump"].proxyAddress;
    const proxyAddress = ctx.outputs["001-deploy-proxy"].proxyAddress;
    const moonbeamWormholeId = Number(required("WORMHOLE_ID_MOONBEAM"));

    return await setAuthorizedEmitter({
      ...ctx.wallet.ethereum,
      basejumpAddress: basejumpAddress as `0x${string}`,
      emitterChain: moonbeamWormholeId,
      emitter: pad(proxyAddress as `0x${string}`, { size: 32 }),
    });
  },
};

export default step;
