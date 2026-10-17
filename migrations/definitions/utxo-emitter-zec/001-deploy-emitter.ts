import type { MigrationStep } from "./types";
import { deploy } from "../../actions/zec-utxo-emitter/deploy";

const step: MigrationStep = {
  name: "001-deploy-emitter",
  description: "Deploy ZecUtxoEmitter UUPS proxy on Hydration",
  action: async (ctx) => {
    return await deploy({ ...ctx.wallet.hydration });
  },
};

export default step;
