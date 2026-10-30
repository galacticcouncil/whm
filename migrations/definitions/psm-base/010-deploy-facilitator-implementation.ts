import type { MigrationStep } from "./types";
import { deployFacilitatorImpl } from "../../actions/psm/upgradeFacilitator";

const step: MigrationStep = {
  name: "010-deploy-facilitator-implementation",
  description: "Deploy the redeemWithPermit facilitator implementation on Hydration (no upgrade)",
  action: async (ctx) => {
    const facilitator = ctx.outputs["004-deploy-facilitator"].proxyAddress;

    return await deployFacilitatorImpl({
      ...ctx.wallet.hydration,
      proxy: facilitator as `0x${string}`,
    });
  },
};

export default step;
