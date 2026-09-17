import type { MigrationStep } from "./types";
import { setOracle } from "../../actions/oracle-receiver/setOracle";

const ZERO = "0x0000000000000000000000000000000000000000";

const step: MigrationStep = {
  name: "009-set-apyusd-checked@receiver",
  description: "Repoint APYUSD oracle to the CheckedOracle on OracleReceiver",
  action: async (ctx) => {
    const receiverAddress = ctx.outputs["002-deploy-receiver"].proxyAddress;
    const oracle = ctx.env.APYUSD_CHECKED_ORACLE_ADDRESS;
    const assetId = ctx.env.APYUSD_ASSET_ID;
    if (!oracle) throw new Error("Missing APYUSD_CHECKED_ORACLE_ADDRESS");
    if (!assetId) throw new Error("Missing APYUSD_ASSET_ID");
    if (oracle.toLowerCase() === ZERO) {
      throw new Error(
        "APYUSD_CHECKED_ORACLE_ADDRESS is the zero placeholder — set the deployed CheckedOracle first",
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
