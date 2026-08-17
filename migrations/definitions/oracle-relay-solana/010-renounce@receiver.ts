import type { MigrationStep } from "./types";
import { setOwner } from "../../actions/setOwner";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

const step: MigrationStep = {
  name: "010-renounce@receiver",
  description: "Renounce OracleReceiver ownership (set owner to zero address)",
  action: async (ctx) => {
    const contract = ctx.outputs["002-deploy-receiver"].proxyAddress;

    return await setOwner({
      ...ctx.wallet.hydration,
      contract: contract as `0x${string}`,
      newOwner: ZERO_ADDRESS,
    });
  },
};

export default step;
