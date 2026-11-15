import { resolve } from "node:path";

import type { MigrationStep } from "./types";
import { deleteKeys } from "../../actions/near-ntt/deleteKeys";

const step: MigrationStep = {
  name: "014-delete-keys@router",
  description: "Delete the router account's keys — upgrades only through its owner",
  action: async (ctx) => {
    const wasm = ctx.env.ROUTER_WASM;
    if (!wasm) throw new Error("Missing ROUTER_WASM");

    // Derivation binds to this account: once its keys are gone, only the owner's `upgrade` can
    // change what signs for every A. Refuses unless the code on chain is ROUTER_WASM.
    return await deleteKeys({
      ...ctx.wallet.near,
      nttAccount: ctx.outputs["003-deploy-router"].routerAccount,
      wasmPath: resolve(wasm),
    });
  },
};

export default step;
