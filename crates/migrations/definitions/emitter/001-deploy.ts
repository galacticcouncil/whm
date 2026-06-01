import type { MigrationStep } from "../../types";
import { deploy } from "../../actions/emitter/deploy";

const step: MigrationStep = {
  name: "deploy",
  description: "Deploy message-emitter program and initialize config",
  action: async (ctx) => {
    return await deploy({
      ...ctx.wallet,
      airdrop: ctx.env.AIRDROP === "true",
    });
  },
};

export default step;
