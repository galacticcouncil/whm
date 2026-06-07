import type { MigrationStep } from "./types";
import { deploy } from "../../actions/intent-emitter/deploy";

// Iteration helper: deploy a fresh impl and upgrade the EXISTING proxy in place
// (upgradeToAndCall with empty data — storage/config preserved, proxy address stable).
// After changing IntentEmitter.sol + `forge build`, re-run just this step:
//   npx tsx migrations/run.ts --migration nintent-ethereum --env lark --from 003-redeploy-emitter
const step: MigrationStep = {
  name: "003-redeploy-emitter",
  description: "Deploy fresh impl + upgrade the existing proxy (keeps proxy address stable)",
  action: async (ctx) => {
    const proxy = ctx.outputs["001-deploy-emitter"].proxyAddress as `0x${string}`;
    return await deploy({
      ...ctx.wallet.hydration,
      proxy,
    });
  },
};

export default step;
