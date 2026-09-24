import { nearToYocto } from "near-api-js";
import { accountHash, call, checked } from "@whm/common/near";

import type { NearContext } from "../types";

export type RegisterEmitterParams = NearContext & {
  core: string;
  nttAccount: string;
};

export type RegisterEmitterResult = {
  txHash: string;
  emitter: string;
};

/**
 * Registers the NTT contract as an emitter on the Wormhole core — `publish_message` panics
 * `EmitterNotRegistered` otherwise. Permissionless; the attached deposit pays the entry's storage
 * and the rest comes back.
 *
 * @param params Deployer wallet, core account, NTT contract account
 * @returns The transaction and the emitter the guardians will sign as (`sha256(nttAccount)`)
 */
export async function registerEmitter(params: RegisterEmitterParams): Promise<RegisterEmitterResult> {
  const { account, core, nttAccount } = params;

  const outcome = await call(account, core, "register_emitter", { emitter: nttAccount }, {
    deposit: nearToYocto("0.01"),
  });
  checked("register_emitter", outcome);

  return { txHash: outcome.transaction.hash, emitter: accountHash(nttAccount) };
}
