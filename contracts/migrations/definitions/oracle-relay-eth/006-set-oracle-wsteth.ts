import type { MigrationStep } from "../../types";
import { setOracle } from "../../actions/dispatcher/setOracle";

const step: MigrationStep = {
  name: "set-oracle-wsteth",
  description: "Register WSTETH oracle on dispatcher",
  action: async (ctx) => {
    const dispatcherAddress = ctx.outputs["deploy-dispatcher"].proxyAddress;
    const oracle = ctx.env.WSTETH_ORACLE_ADDRESS;
    const assetId = ctx.env.WSTETH_ASSET_ID;
    if (!oracle) throw new Error("Missing WSTETH_ORACLE_ADDRESS");
    if (!assetId) throw new Error("Missing WSTETH_ASSET_ID");
    if (oracle.toLowerCase() === "0x0000000000000000000000000000000000000000") {
      throw new Error("WSTETH_ORACLE_ADDRESS is the zero placeholder — set the deployed Hydration oracle first");
    }

    return await setOracle({
      ...ctx.wallet,
      dispatcherAddress: dispatcherAddress as `0x${string}`,
      assetId,
      oracle: oracle as `0x${string}`,
    });
  },
};

export default step;
