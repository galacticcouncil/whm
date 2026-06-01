import type { MigrationStep } from "../../types";
import { deploy } from "../../actions/basejumpLanding/deploy";

const step: MigrationStep = {
  name: "deploy",
  description: "Deploy BasejumpLanding UUPS proxy",
  action: async (ctx) => {
    return await deploy({
      ...ctx.wallet,
    });
  },
};

export default step;
