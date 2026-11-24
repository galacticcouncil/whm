import type { MigrationStep } from "./types";
import { upgrade } from "../../actions/intent-dispatcher/upgrade";

const step: MigrationStep = {
  name: "002-upgrade@dispatcher",
  description: "Upgrade the dispatcher proxy to the implementation from 001",
  action: async (ctx) => {
    const { proxyAddress, implAddress } = ctx.outputs["001-deploy-impl"] as { proxyAddress: string; implAddress: string };
    return await upgrade({
      ...ctx.wallet.hydration,
      proxy: proxyAddress as `0x${string}`,
      impl: implAddress as `0x${string}`,
    });
  },
};

export default step;
