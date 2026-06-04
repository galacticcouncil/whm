import type { MigrationStep } from "./types";
import { deploy } from "../../actions/basejump-landing/deploy";

const step: MigrationStep = {
  name: "004-deploy-landing",
  description: "Deploy BasejumpLanding UUPS proxy on Hydration",
  action: async (ctx) => {
    return await deploy({
      ...ctx.wallet.hydration,
    });
  },
};

export default step;
