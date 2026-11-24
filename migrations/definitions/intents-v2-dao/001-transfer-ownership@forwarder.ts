import { isAddress } from "viem";

import type { MigrationStep } from "./types";
import { setOwner } from "../../actions/setOwner";

const step: MigrationStep = {
  name: "001-transfer-ownership@forwarder",
  description: "Transfer Ethereum forwarder ownership to the Technical Committee Safe",
  action: async (ctx) => {
    const forwarder = ctx.env.ETHEREUM_FORWARDER;
    if (!forwarder || !isAddress(forwarder)) throw new Error(`Missing or invalid ETHEREUM_FORWARDER: ${forwarder}`);
    const newOwner = ctx.env.ETHEREUM_TC_SAFE;
    if (!newOwner || !isAddress(newOwner)) {
      throw new Error(`Missing or invalid ETHEREUM_TC_SAFE: ${newOwner}`);
    }

    return await setOwner({
      ...ctx.wallet.ethereum,
      contract: forwarder as `0x${string}`,
      newOwner: newOwner as `0x${string}`,
    });
  },
};

export default step;
