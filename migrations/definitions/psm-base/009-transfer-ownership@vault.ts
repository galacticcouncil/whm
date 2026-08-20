import type { MigrationStep } from "./types";
import { transferAdmin } from "../../actions/psm/transferAdmin";

const step: MigrationStep = {
  name: "009-transfer-ownership@vault",
  description: "Hand vault DEFAULT_ADMIN_ROLE to the Base technical committee, drop the deployer's",
  action: async (ctx) => {
    const vault = ctx.outputs["002-deploy-vault"].proxyAddress;
    // This key is a path to the reserve itself, and by owner decision it sits behind a 4-of-7
    // multisig rather than a timelock, so an upgrade lands the moment it is signed. It must never
    // be an EOA.
    const newAdmin = ctx.env.VAULT_NEW_OWNER;
    if (!newAdmin) throw new Error("Missing VAULT_NEW_OWNER");

    return await transferAdmin({
      ...ctx.wallet.base,
      contract: vault as `0x${string}`,
      newAdmin: newAdmin as `0x${string}`,
    });
  },
};

export default step;
