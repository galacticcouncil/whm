import type { MigrationStep } from "./types";
import { setOracle } from "../../actions/oracle-receiver/setOracle";

const ZERO = "0x0000000000000000000000000000000000000000";

const step: MigrationStep = {
  name: "006-set-hdx@receiver",
  description: "Register HDX oracle on OracleReceiver",
  action: async (ctx) => {
    const receiverAddress = ctx.outputs["003-deploy-receiver"].proxyAddress;
    const oracle = ctx.env.HDX_ORACLE_ADDRESS;
    const assetId = ctx.env.HDX_ASSET_ID;
    if (!oracle) throw new Error("Missing HDX_ORACLE_ADDRESS");
    if (!assetId) throw new Error("Missing HDX_ASSET_ID");
    if (oracle.toLowerCase() === ZERO) {
      throw new Error(
        `HDX_ORACLE_ADDRESS is the zero placeholder — deploy the Robinhood oracle with setter ${receiverAddress}, then set it`,
      );
    }

    return await setOracle({
      ...ctx.wallet.robinhood,
      receiverAddress: receiverAddress as `0x${string}`,
      assetId,
      oracle: oracle as `0x${string}`,
    });
  },
};

export default step;
