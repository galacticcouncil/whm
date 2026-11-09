import type { MigrationStep } from "./types";
import { setOracle } from "../../actions/oracle-receiver/setOracle";

const ZERO = "0x0000000000000000000000000000000000000000";

const step: MigrationStep = {
  name: "014-set-apyusd-discount@receiver-apyusd",
  description: "Point APYUSD oracle to the DiscountedCheckedOracle on the apyUSD OracleReceiver",
  action: async (ctx) => {
    const receiverAddress = ctx.outputs["012-deploy-receiver-apyusd"].proxyAddress;
    const oracle = ctx.env.APYUSD_DISCOUNT_ORACLE_ADDRESS;
    const assetId = ctx.env.APYUSD_ASSET_ID;
    if (!oracle) throw new Error("Missing APYUSD_DISCOUNT_ORACLE_ADDRESS");
    if (!assetId) throw new Error("Missing APYUSD_ASSET_ID");
    if (oracle.toLowerCase() === ZERO) {
      throw new Error(
        "APYUSD_DISCOUNT_ORACLE_ADDRESS is the zero placeholder — set the deployed DiscountedCheckedOracle first",
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
