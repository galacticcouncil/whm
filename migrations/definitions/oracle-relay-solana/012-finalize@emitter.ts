import type { MigrationStep } from "./types";
import { finalize } from "../../actions/oracle-emitter-solana/finalize";

const step: MigrationStep = {
  name: "012-finalize@emitter",
  description: "Revoke oracle-emitter upgrade authority (program becomes immutable)",
  action: async (ctx) => {
    return await finalize({ ...ctx.wallet.solana });
  },
};

export default step;
