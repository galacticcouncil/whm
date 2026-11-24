import { isAddress } from "viem";

import type { MigrationStep } from "./types";
import { setOwner } from "../../actions/setOwner";

const step: MigrationStep = {
  name: "012-transfer-ownership@forwarder",
  description: "Transfer Ethereum forwarder ownership to the Technical Committee Safe",
  action: async (ctx) => {
    // Left empty in the env until the canary passes, so a full run stops here with every contract
    // still the deployer's: a fix is a deployer call, not a governance vote.
    const newOwner = ctx.env.ETHEREUM_TC_SAFE;
    if (!newOwner || !isAddress(newOwner)) {
      throw new Error(`Missing or invalid ETHEREUM_TC_SAFE: ${newOwner}`);
    }

    return await setOwner({
      ...ctx.wallet.ethereum,
      contract: ctx.outputs["002-deploy-forwarder"].proxyAddress as `0x${string}`,
      newOwner: newOwner as `0x${string}`,
    });
  },
};

export default step;
