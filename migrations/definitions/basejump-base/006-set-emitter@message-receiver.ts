import { pad } from "viem";

import type { MigrationStep } from "./types";
import { setAuthorizedEmitter } from "../../actions/basejump-message-receiver/setAuthorizedEmitter";

const step: MigrationStep = {
  name: "006-set-emitter@message-receiver",
  description: "Authorize the Base Basejump as fast-path emitter",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    // Read from step 001, not env: a fresh deployment is a NEW Wormhole emitter, and an
    // env-copied address could authorize one that does not exist on this context.
    const sourceBasejump = ctx.outputs["001-deploy-basejump"].proxyAddress;

    return await setAuthorizedEmitter({
      ...ctx.wallet.hydration,
      receiverAddress: ctx.outputs["005-deploy-message-receiver"].proxyAddress as `0x${string}`,
      emitterChain: Number(required("WORMHOLE_ID_BASE")),
      emitter: pad(sourceBasejump as `0x${string}`, { size: 32 }),
    });
  },
};

export default step;
