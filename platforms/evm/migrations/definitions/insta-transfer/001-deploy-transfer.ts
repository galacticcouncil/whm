import type { MigrationStep } from "../../types";
import { deployInstaTransfer } from "../../actions/instaTransfer/deploy";

const step: MigrationStep = {
  name: "deploy-transfer",
  description: "Deploy InstaTransfer UUPS proxy",
  action: async (ctx) => {
    return await deployInstaTransfer({
      ...ctx.wallet,
    });
  },
};

export default step;
