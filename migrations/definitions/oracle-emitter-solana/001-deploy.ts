import type { MigrationStep } from "../../solana";
import { deploy } from "../../actions/oracle-emitter-solana/deploy";

const step: MigrationStep = {
  name: "deploy",
  description: "Deploy oracle-emitter program and initialize config",
  action: async (ctx) => {
    return await deploy({
      ...ctx.wallet,
      airdrop: ctx.env.AIRDROP === "true",
    });
  },
};

export default step;
