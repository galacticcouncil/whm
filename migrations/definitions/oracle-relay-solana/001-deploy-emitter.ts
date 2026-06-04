import type { MigrationStep } from "./types";
import { deploy } from "../../actions/oracle-emitter-solana/deploy";

const step: MigrationStep = {
  name: "001-deploy-emitter",
  description: "Deploy oracle-emitter Solana program + initialize config",
  action: async (ctx) => {
    return await deploy({
      ...ctx.wallet.solana,
      airdrop: ctx.env.AIRDROP === "true",
    });
  },
};

export default step;
