import type { MigrationStep } from "./types";
import { setOracle } from "../../actions/oracle-receiver/setOracle";

const step: MigrationStep = {
  name: "008-set-sol@receiver",
  description: "Register SOL oracle on OracleReceiver",
  action: async (ctx) => {
    const receiverAddress = ctx.outputs["002-deploy-receiver"].proxyAddress;
    const oracle = ctx.env.SOL_ORACLE_ADDRESS;
    const assetId = ctx.env.SOL_ASSET_ID_BYTES32;
    if (!oracle) throw new Error("Missing SOL_ORACLE_ADDRESS");
    if (!assetId) throw new Error("Missing SOL_ASSET_ID_BYTES32");

    return await setOracle({
      ...ctx.wallet.hydration,
      receiverAddress: receiverAddress as `0x${string}`,
      assetId,
      oracle: oracle as `0x${string}`,
    });
  },
};

export default step;
