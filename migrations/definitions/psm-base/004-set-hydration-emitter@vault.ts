import { pad } from "viem";

import type { MigrationStep } from "./types";
import { setEmitter } from "../../actions/psm/setEmitter";

const step: MigrationStep = {
  name: "004-set-hydration-emitter@vault",
  description: "Bind the Hydration facilitator as the vault's only authorized emitter (one-shot)",
  action: async (ctx) => {
    const vault = ctx.outputs["002-deploy-vault"].proxyAddress;
    const facilitator = ctx.outputs["001-deploy-facilitator"].proxyAddress;

    return await setEmitter({
      ...ctx.wallet.base,
      contract: vault as `0x${string}`,
      functionName: "setHydrationEmitter",
      emitter: pad(facilitator as `0x${string}`, { size: 32 }),
    });
  },
};

export default step;
