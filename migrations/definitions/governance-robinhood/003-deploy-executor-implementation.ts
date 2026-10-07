import { deployExecutorImplementation } from "../../actions/governance/deploy";
import type { MigrationStep } from "./types";

const step: MigrationStep = {
  name: "003-deploy-executor-implementation",
  description: "Deploy and validate GovernanceExecutor implementation on Robinhood",
  action: async (ctx) => deployExecutorImplementation(ctx.wallet.robinhood),
};

export default step;
