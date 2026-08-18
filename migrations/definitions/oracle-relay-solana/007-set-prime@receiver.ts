import type { MigrationStep } from "./types";
import { setOracle } from "../../actions/oracle-receiver/setOracle";

const step: MigrationStep = {
  name: "007-set-prime@receiver",
  description: "Register PRIME oracle on OracleReceiver",
  action: async (ctx) => {
    const receiverAddress = ctx.outputs["002-deploy-receiver"].proxyAddress;
    const oracle = ctx.env.PRIME_ORACLE_ADDRESS;
    const assetId = ctx.env.PRIME_ASSET_ID_BYTES32;
    if (!oracle) throw new Error("Missing PRIME_ORACLE_ADDRESS");
    if (!assetId) throw new Error("Missing PRIME_ASSET_ID_BYTES32");

    return await setOracle({
      ...ctx.wallet.hydration,
      receiverAddress: receiverAddress as `0x${string}`,
      assetId,
      oracle: oracle as `0x${string}`,
    });
  },
};

export default step;
