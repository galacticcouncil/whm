import type { MigrationStep } from "./types";
import { setFees } from "../../actions/psm/setVaultConfig";

const step: MigrationStep = {
  name: "006-set-fees@vault",
  description: "Set redeem fee and surplus floor on the vault",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    const vault = ctx.outputs["002-deploy-vault"].proxyAddress;

    return await setFees({
      ...ctx.wallet.base,
      contract: vault as `0x${string}`,
      redeemFeeBps: BigInt(required("REDEEM_FEE_BPS")),
      surplusFloorBps: BigInt(required("SURPLUS_FLOOR_BPS")),
    });
  },
};

export default step;
