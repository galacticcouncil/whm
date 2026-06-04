import type { MigrationStep } from "./types";
import { registerPoolFeed } from "../../actions/oracle-emitter-solana/registerPoolFeed";

const step: MigrationStep = {
  name: "008-register-jitosol@emitter",
  description: "Register JitoSOL pool feed on Solana oracle emitter",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    return await registerPoolFeed({
      ...ctx.wallet.solana,
      assetId: required("JITOSOL_ASSET_ID"),
      stakePool: required("JITOSOL_STAKE_POOL"),
    });
  },
};

export default step;
