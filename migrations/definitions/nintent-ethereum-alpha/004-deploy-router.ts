import type { MigrationStep } from "./types";
import { deploy } from "../../actions/intent-router/deploy";

const step: MigrationStep = {
  name: "004-deploy-router",
  description: "Deploy IntentRouter UUPS proxy on Ethereum",
  action: async (ctx) => {
    const basejumpLanding = ctx.outputs["003-deploy-landing"].proxyAddress;

    return await deploy({
      ...ctx.wallet.ethereum,
      basejumpLanding: basejumpLanding as `0x${string}`,
    });
  },
};

export default step;
