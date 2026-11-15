import { isAddress } from "viem";

import type { MigrationStep } from "./types";
import { deploy } from "../../actions/intent-forwarder/deploy";

const step: MigrationStep = {
  name: "002-deploy-forwarder",
  description: "Deploy IntentForwarder UUPS proxy on Ethereum",
  action: async (ctx) => {
    const wormhole = ctx.env.WORMHOLE_CORE_ETHEREUM;
    const transceiver = ctx.env.NTT_TRANSCEIVER_ETHEREUM;
    if (!wormhole || !isAddress(wormhole)) {
      throw new Error(`Missing or invalid WORMHOLE_CORE_ETHEREUM: ${wormhole}`);
    }
    if (!transceiver || !isAddress(transceiver)) {
      throw new Error(`Missing or invalid NTT_TRANSCEIVER_ETHEREUM: ${transceiver}`);
    }

    return await deploy({
      ...ctx.wallet.ethereum,
      wormhole: wormhole as `0x${string}`,
      transceiver: transceiver as `0x${string}`,
    });
  },
};

export default step;
