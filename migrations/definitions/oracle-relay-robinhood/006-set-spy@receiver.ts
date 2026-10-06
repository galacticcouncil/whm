import type { MigrationStep } from "./types";
import { setOracle } from "../../actions/oracle-receiver/setOracle";

const ZERO = "0x0000000000000000000000000000000000000000";

const step: MigrationStep = {
  name: "006-set-spy@receiver",
  description: "Register SPY oracle on OracleReceiver",
  action: async (ctx) => {
    const receiverAddress = ctx.outputs["003-deploy-receiver"].proxyAddress;
    const oracle = ctx.env.SPY_ORACLE_ADDRESS;
    const assetId = ctx.env.SPY_ASSET_ID;
    if (!oracle) throw new Error("Missing SPY_ORACLE_ADDRESS");
    if (!assetId) throw new Error("Missing SPY_ASSET_ID");
    if (oracle.toLowerCase() === ZERO) {
      throw new Error(
        `SPY_ORACLE_ADDRESS is the zero placeholder — deploy the Hydration oracle with setter ${receiverAddress}, then set it`,
      );
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
