import { pad } from "viem";

import type { MigrationStep } from "./types";
import { setProxyLandingDest } from "../../actions/basejump/setProxyLandingDest";

const step: MigrationStep = {
  name: "009-set-landing-dest@proxy",
  description: "Register Ethereum BasejumpLandingNative as LandingDest on Moonbeam BasejumpProxy",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    const proxyAddress = ctx.outputs["001-deploy-proxy"].proxyAddress;
    const landingAddress = ctx.outputs["003-deploy-landing"].proxyAddress;
    const ethereumWormholeId = Number(required("WORMHOLE_ID_ETHEREUM"));

    return await setProxyLandingDest({
      ...ctx.wallet.moonbeam,
      basejumpAddress: proxyAddress as `0x${string}`,
      toWhChain: ethereumWormholeId,
      landingDest: pad(landingAddress as `0x${string}`, { size: 32 }),
    });
  },
};

export default step;
