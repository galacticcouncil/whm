import type { MigrationStep } from "./types";
import { deploy } from "../../actions/basejump-landing-native/deploy";

const step: MigrationStep = {
  name: "003-deploy-landing",
  description: "Deploy BasejumpLandingNative UUPS proxy on Ethereum",
  action: async (ctx) => {
    return await deploy({
      ...ctx.wallet.ethereum,
    });
  },
};

export default step;
