import type { MigrationStep } from "./types";
import { setNttManager } from "../../actions/basejump/setNttManager";

const step: MigrationStep = {
  name: "003-set-eurc-ntt-manager@basejump",
  description: "Register the EURC NTT manager as its settlement route",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    return await setNttManager({
      ...ctx.wallet.base,
      basejumpAddress: ctx.outputs["001-deploy-basejump"].proxyAddress as `0x${string}`,
      asset: required("EURC_SOURCE_ASSET") as `0x${string}`,
      manager: required("EURC_NTT_MANAGER") as `0x${string}`,
    });
  },
};

export default step;
