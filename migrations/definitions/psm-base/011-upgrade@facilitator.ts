import type { MigrationStep } from "./types";
import { verifyFacilitatorUpgrade } from "../../actions/psm/upgradeFacilitator";

const step: MigrationStep = {
  name: "011-upgrade@facilitator",
  description: "Facilitator proxy upgraded to the 010 implementation by its admin (verified, not sent)",
  action: async (ctx) => {
    const facilitator = ctx.outputs["004-deploy-facilitator"].proxyAddress;
    const implAddress = ctx.outputs["010-deploy-facilitator-implementation"].implAddress;

    return await verifyFacilitatorUpgrade({
      ...ctx.wallet.hydration,
      proxy: facilitator as `0x${string}`,
      implAddress: implAddress as `0x${string}`,
    });
  },
};

export default step;
