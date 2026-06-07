import type { MigrationStep } from "./types";
import { deploy } from "../../actions/intent-emitter/deploy";

const step: MigrationStep = {
  name: "001-deploy-emitter",
  description: "Deploy IntentEmitter UUPS proxy on Hydration",
  action: async (ctx) => {
    return await deploy({
      ...ctx.wallet.hydration,
    });
  },
};

export default step;
