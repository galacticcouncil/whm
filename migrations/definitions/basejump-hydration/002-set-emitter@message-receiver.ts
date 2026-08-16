import { pad } from "viem";

import type { MigrationStep } from "./types";
import { setAuthorizedEmitter } from "../../actions/basejump-message-receiver/setAuthorizedEmitter";

const step: MigrationStep = {
  name: "002-set-emitter@message-receiver",
  description: "Authorize the source-chain Basejump as fast-path emitter",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    const sourceBasejump = ctx.env.BASEJUMP_BASE;
    if (!sourceBasejump || /^0x0+$/.test(sourceBasejump)) {
      throw new Error(
        "BASEJUMP_BASE is unset or zero — run basejump-base-ntt first, then copy " +
          "001-deploy-basejump.proxyAddress from deployments/<context>/basejump-base-ntt.json",
      );
    }

    const receiverAddress = ctx.outputs["001-deploy-message-receiver"].proxyAddress;

    return await setAuthorizedEmitter({
      ...ctx.wallet.hydration,
      receiverAddress: receiverAddress as `0x${string}`,
      emitterChain: Number(required("WORMHOLE_ID_BASE")),
      emitter: pad(sourceBasejump as `0x${string}`, { size: 32 }),
    });
  },
};

export default step;
