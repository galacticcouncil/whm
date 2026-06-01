import type { MigrationStep } from "../../types";
import { setOracle } from "../../actions/dispatcher/setOracle";

const step: MigrationStep = {
  name: "set-oracle-jitosol",
  description: "Register JitoSOL oracle on dispatcher",
  action: async (ctx) => {
    const dispatcherAddress = ctx.outputs["deploy-dispatcher"].proxyAddress;
    const oracle = ctx.env.JITOSOL_ORACLE_ADDRESS;
    const assetId = ctx.env.JITOSOL_ASSET_ID;
    if (!oracle) throw new Error("Missing JITOSOL_ORACLE_ADDRESS");
    if (!assetId) throw new Error("Missing JITOSOL_ASSET_ID");

    return await setOracle({
      ...ctx.wallet,
      dispatcherAddress: dispatcherAddress as `0x${string}`,
      assetId,
      oracle: oracle as `0x${string}`,
    });
  },
};

export default step;
