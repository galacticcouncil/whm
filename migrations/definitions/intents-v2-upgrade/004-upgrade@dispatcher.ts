import type { MigrationStep } from "./types";
import { upgrade } from "../../actions/intent-dispatcher/upgrade";

const step: MigrationStep = {
  name: "004-upgrade@dispatcher",
  description: "Upgrade the dispatcher proxy to the implementation from 003",
  action: async (ctx) => {
    const { proxyAddress, implAddress } = ctx.outputs["003-deploy-impl"] as { proxyAddress: string; implAddress: string };
    return await upgrade({
      ...ctx.wallet.hydration,
      proxy: proxyAddress as `0x${string}`,
      impl: implAddress as `0x${string}`,
    });
  },
};

export default step;
