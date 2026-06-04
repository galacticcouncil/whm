import type { MigrationStep } from "./types";
import { setOracle } from "../../actions/oracle-dispatcher/setOracle";

const step: MigrationStep = {
  name: "011-set-prime@dispatcher",
  description: "Register PRIME oracle on dispatcher",
  action: async (ctx) => {
    const dispatcherAddress = ctx.outputs["002-deploy-dispatcher"].proxyAddress;
    const oracle = ctx.env.PRIME_ORACLE_ADDRESS;
    const assetId = ctx.env.PRIME_ASSET_ID_BYTES32;
    if (!oracle) throw new Error("Missing PRIME_ORACLE_ADDRESS");
    if (!assetId) throw new Error("Missing PRIME_ASSET_ID_BYTES32");

    return await setOracle({
      ...ctx.wallet.moonbeam,
      dispatcherAddress: dispatcherAddress as `0x${string}`,
      assetId,
      oracle: oracle as `0x${string}`,
    });
  },
};

export default step;
