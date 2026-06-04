import { pad } from "viem";

import type { MigrationStep } from "./types";
import { setProxyLanding } from "../../actions/basejump/setProxyLanding";

const step: MigrationStep = {
  name: "009-set-landing@proxy",
  description: "Register Hydration Landing on BasejumpProxy for source chain",
  action: async (ctx) => {
    const proxyAddress = ctx.outputs["002-deploy-proxy"].proxyAddress;
    const landingAddress = ctx.outputs["004-deploy-landing"].proxyAddress;
    const wormholeId = ctx.outputs["001-deploy-basejump"].wormholeId;
    if (!wormholeId) throw new Error("Missing wormholeId from 008-deploy-basejump");

    return await setProxyLanding({
      ...ctx.wallet.moonbeam,
      basejumpAddress: proxyAddress as `0x${string}`,
      fromWhChain: Number(wormholeId),
      landing: pad(landingAddress as `0x${string}`, { size: 32 }),
    });
  },
};

export default step;
