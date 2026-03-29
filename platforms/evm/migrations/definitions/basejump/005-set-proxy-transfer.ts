import { pad } from "viem";

import type { MigrationStep } from "../../types";
import { setBasejumpLanding } from "../../actions/basejump/setBasejumpLanding";

const step: MigrationStep = {
  name: "set-transfer-proxy",
  description: "Register BasejumpLanding (proxy) on Basejump",
  action: async (ctx) => {
    const bridgeAddress = ctx.outputs["deploy-bridge"].proxyAddress;
    const proxyTransferAddress = ctx.ref("basejump-landing", "deploy-transfer").proxyAddress;

    return await setBasejumpLanding({
      ...ctx.wallet,
      basejumpAddress: bridgeAddress as `0x${string}`,
      whChainId: 16,
      basejumpLanding: pad(proxyTransferAddress as `0x${string}`, { size: 32 }),
    });
  },
};

export default step;
