import { pad } from "viem";

import type { MigrationStep } from "./types";
import { setAuthorizedEmitter } from "../../actions/basejump/setAuthorizedEmitter";

const step: MigrationStep = {
  name: "010-set-emitter@basejump",
  description: "Register BasejumpProxy as authorized emitter on Basejump (source chain)",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    const basejumpAddress = ctx.outputs["001-deploy-basejump"].proxyAddress;
    const proxyAddress = ctx.outputs["002-deploy-proxy"].proxyAddress;
    const moonbeamWormholeId = Number(required("WORMHOLE_ID_MOONBEAM"));

    return await setAuthorizedEmitter({
      ...ctx.wallet.base,
      basejumpAddress: basejumpAddress as `0x${string}`,
      emitterChain: moonbeamWormholeId,
      emitter: pad(proxyAddress as `0x${string}`, { size: 32 }),
    });
  },
};

export default step;
