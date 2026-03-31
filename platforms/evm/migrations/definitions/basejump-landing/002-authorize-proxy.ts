import type { MigrationStep } from "../../types";
import { setAuthorizedBridge } from "../../actions/basejumpLanding/setAuthorizedBridge";

const step: MigrationStep = {
  name: "authorize-proxy",
  description: "Authorize BasejumpProxy Transactor MDA on BasejumpLanding",
  action: async (ctx) => {
    const proxyEnv = ctx.env.PROXY_ENV;
    if (!proxyEnv) throw new Error("Missing PROXY_ENV");

    const basejumpLandingAddress = ctx.outputs["deploy"].proxyAddress;
    const proxyTransactorMda = ctx.ref("basejump-proxy", "deploy-transactor", proxyEnv).mdaH160;

    return await setAuthorizedBridge({
      ...ctx.wallet,
      basejumpLandingAddress: basejumpLandingAddress as `0x${string}`,
      bridgeAddress: proxyTransactorMda as `0x${string}`,
      enabled: true,
    });
  },
};

export default step;
