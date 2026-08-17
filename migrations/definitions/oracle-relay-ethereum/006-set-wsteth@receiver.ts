import type { MigrationStep } from "./types";
import { setOracle } from "../../actions/oracle-receiver/setOracle";

const ZERO = "0x0000000000000000000000000000000000000000";

const step: MigrationStep = {
  name: "006-set-wsteth@receiver",
  description: "Register WSTETH oracle on OracleReceiver",
  action: async (ctx) => {
    const receiverAddress = ctx.outputs["002-deploy-receiver"].proxyAddress;
    const oracle = ctx.env.WSTETH_ORACLE_ADDRESS;
    const assetId = ctx.env.WSTETH_ASSET_ID;
    if (!oracle) throw new Error("Missing WSTETH_ORACLE_ADDRESS");
    if (!assetId) throw new Error("Missing WSTETH_ASSET_ID");
    if (oracle.toLowerCase() === ZERO) {
      throw new Error("WSTETH_ORACLE_ADDRESS is the zero placeholder — set the deployed Hydration oracle first");
    }

    return await setOracle({
      ...ctx.wallet.hydration,
      receiverAddress: receiverAddress as `0x${string}`,
      assetId,
      oracle: oracle as `0x${string}`,
    });
  },
};

export default step;
