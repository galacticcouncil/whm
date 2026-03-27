import { pad } from "viem";

import type { MigrationStep } from "../../types";
import { setInstaTransfer } from "../../actions/instaBridge/setInstaTransfer";

const step: MigrationStep = {
  name: "set-transfer",
  description: "Register InstaTransfer on InstaBridge",
  action: async (ctx) => {
    const env = ctx.env;
    const required = (key: string) => {
      if (!env[key]) throw new Error(`Missing ${key}`);
      return env[key];
    };

    const bridgeAddress = ctx.outputs["deploy-bridge"].proxyAddress;
    const transferAddress = ctx.outputs["deploy-transfer"].proxyAddress;

    return await setInstaTransfer({
      ...ctx.wallet,
      instaBridgeAddress: bridgeAddress as `0x${string}`,
      whChainId: Number(required("WORMHOLE_ID")),
      instaTransfer: pad(transferAddress as `0x${string}`, { size: 32 }),
    });
  },
};

export default step;
