import type { ifs } from "@whm/common/evm";

import type { MigrationStep } from "./types";
import { deploy } from "../../actions/intent-emitter/deploy";

import intentEmitterWttJson from "../../../contracts/out/IntentEmitterWtt.sol/IntentEmitterWtt.json";

const step: MigrationStep = {
  name: "001-deploy-emitter",
  description: "Deploy IntentEmitterWtt UUPS proxy on Hydration",
  action: async (ctx) => {
    return await deploy({
      ...ctx.wallet.hydration,
      artifact: intentEmitterWttJson as ifs.ContractArtifact,
    });
  },
};

export default step;
