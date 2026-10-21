import { deployExecutorImplementation } from "../../actions/governance/deploy";
import type { MigrationStep } from "./types";

const step: MigrationStep = {
  name: "001-deploy-executor-implementation",
  description: "Deploy and validate GovernanceExecutor implementation on Ethereum",
  action: async (ctx) => deployExecutorImplementation(ctx.wallet.ethereum),
};

export default step;
