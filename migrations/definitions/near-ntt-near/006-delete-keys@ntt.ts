import { resolve } from "node:path";

import type { MigrationStep } from "./types";
import { deleteKeys } from "../../actions/near-ntt/deleteKeys";

const step: MigrationStep = {
  name: "006-delete-keys@ntt",
  description: "Delete the NTT contract account's keys — upgrades only through its owner",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    return await deleteKeys({
      ...ctx.wallet.near,
      nttAccount: ctx.outputs["001-deploy-ntt"].nttAccount,
      wasmPath: resolve(required("NTT_WASM")),
    });
  },
};

export default step;
