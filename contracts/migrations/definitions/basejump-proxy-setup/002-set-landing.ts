import { pad } from "viem";

import type { MigrationStep } from "../../types";
import { setProxyLanding } from "../../actions/basejump/setProxyLanding";

const step: MigrationStep = {
  name: "set-landing",
  description: "Register Landing on BasejumpProxy for source chain",
  action: async (ctx) => {
    const proxyEnv = ctx.env.PROXY_ENV;
    if (!proxyEnv) throw new Error("Missing PROXY_ENV");

    const proxyAddress = ctx.ref("basejump-proxy", "deploy-proxy", proxyEnv).proxyAddress;
    const landingAddress = ctx.ref("basejump-landing", "deploy").proxyAddress;
    const { wormholeId } = ctx.ref("basejump", "deploy");

    return await setProxyLanding({
      ...ctx.wallet,
      basejumpAddress: proxyAddress as `0x${string}`,
      fromWhChain: Number(wormholeId),
      landing: pad(landingAddress as `0x${string}`, { size: 32 }),
    });
  },
};

export default step;
