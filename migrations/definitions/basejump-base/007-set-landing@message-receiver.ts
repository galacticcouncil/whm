import { pad } from "viem";

import type { MigrationStep } from "./types";
import { setLanding } from "../../actions/basejump-message-receiver/setLanding";

const step: MigrationStep = {
  name: "007-set-landing@message-receiver",
  description: "Point the Hydration receiver at the existing landing pool",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    // Same constant the source reads for setLandingDest — invariant 1 holds by construction.
    const landingAddress = required("HYDRATION_LANDING");

    const receiverAddress = ctx.outputs["005-deploy-message-receiver"].proxyAddress;

    return await setLanding({
      ...ctx.wallet.hydration,
      receiverAddress: receiverAddress as `0x${string}`,
      landing: pad(landingAddress as `0x${string}`, { size: 32 }),
    });
  },
};

export default step;
