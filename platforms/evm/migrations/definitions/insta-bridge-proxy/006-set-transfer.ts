import { pad } from "viem";

import type { MigrationStep } from "../../types";
import { setInstaTransfer } from "../../actions/instaBridge/setInstaTransfer";

const step: MigrationStep = {
  name: "set-transfer",
  description: "Register InstaTransfer on InstaBridgeProxy",
  action: async (ctx) => {
    const env = ctx.env;
    const required = (key: string) => {
      if (!env[key]) throw new Error(`Missing ${key}`);
      return env[key];
    };

    const bridgeAddress = ctx.outputs["deploy-bridge-proxy"].proxyAddress;
    const transferAddress = ctx.ref("insta-transfer", "deploy-transfer").proxyAddress;

    return await setInstaTransfer({
      ...ctx.wallet,
      instaBridgeAddress: bridgeAddress as `0x${string}`,
      whChainId: 16,
      instaTransfer: pad(transferAddress as `0x${string}`, { size: 32 }),
    });
  },
};

export default step;
