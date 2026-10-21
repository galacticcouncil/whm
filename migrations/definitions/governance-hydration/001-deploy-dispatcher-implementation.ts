import { deployDispatcherImplementation } from "../../actions/governance/deploy";
import type { MigrationStep } from "./types";

const step: MigrationStep = {
  name: "001-deploy-dispatcher-implementation",
  description: "Deploy and validate GovernanceDispatcher implementation on Hydration",
  action: async (ctx) => deployDispatcherImplementation(ctx.wallet.hydration),
};

export default step;
