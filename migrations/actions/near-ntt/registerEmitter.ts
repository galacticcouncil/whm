import { actions, nearToYocto, teraToGas } from "near-api-js";
import { accountHash, checked, receiptFailures } from "@whm/common/near";

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

  // Not `call`: near-api-js throws on a failed receipt by default, before the check below sees it.
  const outcome = await account.signAndSendTransaction({
    receiverId: core,
    actions: [
      actions.functionCall("register_emitter", { emitter: nttAccount }, teraToGas(100), nearToYocto("0.01")),
    ],
    waitUntil: "FINAL",
    throwOnFailure: false,
  });
  // Registration is permissionless: someone may have registered the account first. That is the
  // same registration — the core keys it by account and signs as `sha256(account)` either way.
  // It also outlives the account: a contract redeployed on the same account finds it registered.
  const failures = receiptFailures(outcome);
  const takenFirst = failures.length > 0 && JSON.stringify(failures).includes("AlreadyRegistered");
  if (!takenFirst) checked("register_emitter", outcome);

  return { txHash: outcome.transaction.hash, emitter: accountHash(nttAccount) };
}
