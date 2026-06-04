import type { MigrationStep } from "./types";
import { setOwner } from "../../actions/setOwner";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

const step: MigrationStep = {
  name: "015-renounce@dispatcher",
  description: "Renounce OracleDispatcher ownership (set owner to zero address)",
  action: async (ctx) => {
    const contract = ctx.outputs["002-deploy-dispatcher"].proxyAddress;

    return await setOwner({
      ...ctx.wallet.moonbeam,
      contract: contract as `0x${string}`,
      newOwner: ZERO_ADDRESS,
    });
  },
};

export default step;
