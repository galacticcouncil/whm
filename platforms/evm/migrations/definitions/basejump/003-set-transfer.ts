import { pad } from "viem";

import type { MigrationStep } from "../../types";
import { setBasejumpLanding } from "../../actions/basejump/setBasejumpLanding";

const step: MigrationStep = {
  name: "set-transfer",
  description: "Register BasejumpLanding on Basejump",
  action: async (ctx) => {
    const env = ctx.env;
    const required = (key: string) => {
      if (!env[key]) throw new Error(`Missing ${key}`);
      return env[key];
    };

    const bridgeAddress = ctx.outputs["deploy-bridge"].proxyAddress;
    const transferAddress = ctx.outputs["deploy-transfer"].proxyAddress;

    return await setBasejumpLanding({
      ...ctx.wallet,
      basejumpAddress: bridgeAddress as `0x${string}`,
      whChainId: Number(required("WORMHOLE_ID")),
      basejumpLanding: pad(transferAddress as `0x${string}`, { size: 32 }),
    });
  },
};

export default step;
