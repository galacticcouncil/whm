import { isAddress } from "viem";

import type { MigrationStep } from "./types";
import { setOwner } from "../../actions/setOwner";

const step: MigrationStep = {
  name: "007-transfer-ownership@receiver",
  description: "Transfer Ethereum receiver ownership to the Technical Committee Safe",
  action: async (ctx) => {
    const newOwner = ctx.env.ETHEREUM_TC_SAFE;
    if (!newOwner || !isAddress(newOwner)) {
      throw new Error(`Missing or invalid ETHEREUM_TC_SAFE: ${newOwner}`);
    }

    // The delivery side goes first — after this, setAuthorizedRelayer and _authorizeUpgrade are
    // Safe transactions, so the emitter stays deployer-owned one step longer.
    return await setOwner({
      ...ctx.wallet.ethereum,
      contract: ctx.outputs["002-deploy-receiver"].proxyAddress as `0x${string}`,
      newOwner: newOwner as `0x${string}`,
    });
  },
};

export default step;
