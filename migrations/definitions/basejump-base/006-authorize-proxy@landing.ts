import type { MigrationStep } from "./types";
import { setAuthorizedBridge } from "../../actions/basejump-landing/setAuthorizedBridge";

const step: MigrationStep = {
  name: "006-authorize-proxy@landing",
  description: "Authorize BasejumpProxy Transactor MDA on BasejumpLanding (Hydration)",
  action: async (ctx) => {
    const basejumpLandingAddress = ctx.outputs["004-deploy-landing"].proxyAddress;
    const proxyTransactorMda = ctx.outputs["003-deploy-transactor"].mdaH160;
    if (!proxyTransactorMda) throw new Error("Missing mdaH160 from 002-deploy-transactor");

    return await setAuthorizedBridge({
      ...ctx.wallet.hydration,
      basejumpLandingAddress: basejumpLandingAddress as `0x${string}`,
      bridgeAddress: proxyTransactorMda as `0x${string}`,
      enabled: true,
    });
  },
};

export default step;
