import type { MigrationStep } from "./types";
import { configure } from "../../actions/intent-emitter/configure";

const step: MigrationStep = {
  name: "002-set-config@emitter",
  description: "Set BasejumpProxy + IntentRouter on IntentEmitter (placeholder addrs — testing only)",
  action: async (ctx) => {
    const emitter = ctx.outputs["001-deploy-emitter"].proxyAddress as `0x${string}`;

    return await configure({
      ...ctx.wallet.hydration,
      emitter,
      // placeholders just to clear the NotConfigured gate
      basejumpProxy: "0x000000000000000000000000000000000000dead",
      intentRouter: "0x000000000000000000000000000000000000000000000000000000000000dead",
    });
  },
};

export default step;
