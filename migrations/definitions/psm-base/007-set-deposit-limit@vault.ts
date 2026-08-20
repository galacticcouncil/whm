import type { MigrationStep } from "./types";
import { setDepositLimit } from "../../actions/psm/setVaultConfig";

const step: MigrationStep = {
  name: "007-set-deposit-limit@vault",
  description: "Set the deposit rate limit (unset means closed, never unlimited)",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    const vault = ctx.outputs["002-deploy-vault"].proxyAddress;

    return await setDepositLimit({
      ...ctx.wallet.base,
      contract: vault as `0x${string}`,
      capacity: BigInt(required("DEPOSIT_LIMIT_CAPACITY")),
      window: BigInt(required("DEPOSIT_LIMIT_WINDOW")),
    });
  },
};

export default step;
