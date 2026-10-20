import { wallet } from "@whm/common/evm";

import type { MigrationConfig } from "./types";

/**
 * ZEC withdrawals, Hydration side — the ZecUtxoEmitter.
 *
 * `send` settles ZEC over NTT to the NEAR account a Zcash address derives and logs the address
 * beside it; `refuel` turns the kept fees into NEAR for the relayer. The NEAR side —
 * `withdraw-zec.hydration-whm.near` — is utxo-withdraw-zec.
 *
 *   001 deploy ZecUtxoEmitter (UUPS proxy, initialized in the same transaction)
 *   002 set the fee @emitter
 *   003 set the NEAR NttManager @emitter  — refuel's rail
 *   004 set the ZEC NttManager @emitter   — send goes live here, so it comes after the fee
 *   005 transfer ownership to the Hydration Emergency Admin
 *
 * Not renounced — UUPS with _authorizeUpgrade onlyOwner, so the TC keeps the upgrade path, and
 * setFee, refuel and sweep become TC calls from 005 onward.
 *
 * Required PK env vars:
 *   PK — Hydration deployer (must hold an EVMAccounts.ContractDeployer slot)
 *
 * Env file: migrations/envs/<context>/utxo-emitter-zec.env
 */
const config: MigrationConfig = {
  name: "utxo-emitter-zec",
  description: "Deploy the Hydration ZecUtxoEmitter and wire it to the ZEC and NEAR NTT managers",
  pks: ["PK"],

  setup(env) {
    const required = (k: string) => {
      const v = env[k];
      if (!v) throw new Error(`Missing ${k}`);
      return v;
    };

    return {
      hydration: wallet.getWallet(
        required("RPC_HYDRATION"),
        Number(required("CHAIN_ID_HYDRATION")),
        env.PK as `0x${string}`,
      ),
    };
  },
};

export default config;
