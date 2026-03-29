import { pad } from "viem";

import type { MigrationStep } from "../../types";
import { setBasejumpLanding } from "../../actions/basejump/setBasejumpLanding";

const step: MigrationStep = {
  name: "set-bridge-transfer",
  description: "Register BasejumpLanding on Basejump",
  action: async (ctx) => {
    const bridgeAddress = ctx.outputs["deploy-bridge-proxy"].proxyAddress;
    const { basejumpLanding, whChainId } = ctx.ref("basejump", "set-transfer");

    return await setBasejumpLanding({
      ...ctx.wallet,
      basejumpAddress: bridgeAddress as `0x${string}`,
      whChainId: Number(whChainId),
      basejumpLanding: pad(basejumpLanding as `0x${string}`, { size: 32 }),
    });
  },
};

export default step;
