import type { MigrationStep } from "./types";
import { setDepositLimit, setPayoutLimit } from "../../actions/psm/setVaultConfig";

const step: MigrationStep = {
  name: "003-set-limits@vault",
  description: "Set the deposit and payout rate limits (unset means closed, never unlimited)",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    const vault = ctx.outputs["001-deploy-vault"].proxyAddress;

    const deposit = await setDepositLimit({
      ...ctx.wallet.base,
      contract: vault as `0x${string}`,
      capacity: BigInt(required("DEPOSIT_LIMIT_CAPACITY")),
      window: BigInt(required("DEPOSIT_LIMIT_WINDOW")),
    });

    const payout = await setPayoutLimit({
      ...ctx.wallet.base,
      contract: vault as `0x${string}`,
      capacity: BigInt(required("PAYOUT_LIMIT_CAPACITY")),
      window: BigInt(required("PAYOUT_LIMIT_WINDOW")),
    });

    return {
      contract: deposit.contract,
      depositLimitTx: deposit.txHash,
      payoutLimitTx: payout.txHash,
    };
  },
};

export default step;
