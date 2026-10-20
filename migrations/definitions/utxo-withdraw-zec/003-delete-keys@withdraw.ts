import { resolve } from "node:path";

import type { MigrationStep } from "./types";
import { deleteKeys } from "../../actions/near-ntt/deleteKeys";

const step: MigrationStep = {
  name: "003-delete-keys@withdraw",
  description: "Delete the withdraw contract account's keys — upgrades only through its owner",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    // The near-ntt action: checks the code on chain is the wasm with `upgrade`, then deletes every key.
    return await deleteKeys({
      ...ctx.wallet.near,
      nttAccount: ctx.outputs["001-deploy-withdraw"].withdrawAccount,
      wasmPath: resolve(required("WITHDRAW_WASM")),
    });
  },
};

export default step;
