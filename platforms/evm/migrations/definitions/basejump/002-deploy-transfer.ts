import type { MigrationStep } from "../../types";
import { deployBasejumpLanding } from "../../actions/basejumpLanding/deploy";

const step: MigrationStep = {
  name: "deploy-transfer",
  description: "Deploy BasejumpLanding UUPS proxy",
  action: async (ctx) => {
    return await deployBasejumpLanding({
      ...ctx.wallet,
    });
  },
};

export default step;
