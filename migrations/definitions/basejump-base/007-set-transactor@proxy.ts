import type { MigrationStep } from "./types";
import { setXcmTransactor } from "../../actions/basejump/setXcmTransactor";

const step: MigrationStep = {
  name: "007-set-transactor@proxy",
  description: "Set XcmTransactor address on BasejumpProxy",
  action: async (ctx) => {
    const proxyAddress = ctx.outputs["002-deploy-proxy"].proxyAddress;
    const transactorAddress = ctx.outputs["003-deploy-transactor"].proxyAddress;

    return await setXcmTransactor({
      ...ctx.wallet.moonbeam,
      basejumpProxyAddress: proxyAddress as `0x${string}`,
      xcmTransactor: transactorAddress as `0x${string}`,
    });
  },
};

export default step;
