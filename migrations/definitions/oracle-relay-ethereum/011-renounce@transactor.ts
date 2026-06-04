import type { MigrationStep } from "./types";
import { setOwner } from "../../actions/setOwner";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

const step: MigrationStep = {
  name: "011-renounce@transactor",
  description: "Renounce XcmTransactor ownership (set owner to zero address)",
  action: async (ctx) => {
    const contract = ctx.outputs["003-deploy-transactor"].proxyAddress;

    return await setOwner({
      ...ctx.wallet.moonbeam,
      contract: contract as `0x${string}`,
      newOwner: ZERO_ADDRESS,
    });
  },
};

export default step;
