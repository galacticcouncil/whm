import type { MigrationStep } from "../../evm";
import { deploy } from "../../actions/basejump-landing/deploy";

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
