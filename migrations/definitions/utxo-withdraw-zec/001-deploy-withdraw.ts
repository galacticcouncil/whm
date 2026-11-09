import { resolve } from "node:path";

import { nearToYocto } from "near-api-js";

import type { MigrationStep } from "./types";
import { deployWithdraw } from "../../actions/utxo-withdraw/deploy";

const step: MigrationStep = {
  name: "001-deploy-withdraw",
  description: "Create <prefix>.<deployer>, deploy utxo-withdraw and initialise it",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    return await deployWithdraw({
      ...ctx.wallet.near,
      prefix: required("WITHDRAW_PREFIX"),
      balance: nearToYocto(required("WITHDRAW_BALANCE") as `${number}`),
      wasmPath: resolve(required("WITHDRAW_WASM")),
      chain: required("WITHDRAW_CHAIN"),
      connectorChain: required("CONNECTOR_CHAIN"),
      mpcSigner: required("MPC_SIGNER_NEAR"),
      token: required("TOKEN_NEAR"),
      connector: required("CONNECTOR_NEAR"),
      validity: Number(required("WITHDRAW_VALIDITY")),
      withdrawTgas: Number(required("WITHDRAW_TGAS")),
    });
  },
};

export default step;
