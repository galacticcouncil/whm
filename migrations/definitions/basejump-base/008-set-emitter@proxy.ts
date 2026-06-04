import { pad } from "viem";

import type { MigrationStep } from "./types";
import { setAuthorizedEmitter } from "../../actions/basejump/setAuthorizedEmitter";

const step: MigrationStep = {
  name: "008-set-emitter@proxy",
  description: "Register source-chain Basejump as authorized emitter on BasejumpProxy (Moonbeam)",
  action: async (ctx) => {
    const proxyAddress = ctx.outputs["002-deploy-proxy"].proxyAddress;
    const basejumpAddress = ctx.outputs["001-deploy-basejump"].proxyAddress;
    const wormholeId = ctx.outputs["001-deploy-basejump"].wormholeId;
    if (!wormholeId) throw new Error("Missing wormholeId from 008-deploy-basejump");

    return await setAuthorizedEmitter({
      ...ctx.wallet.moonbeam,
      basejumpAddress: proxyAddress as `0x${string}`,
      emitterChain: Number(wormholeId),
      emitter: pad(basejumpAddress as `0x${string}`, { size: 32 }),
    });
  },
};

export default step;
