import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { Account, actions, baseDecode, PublicKey } from "near-api-js";
import { checked, view } from "@whm/common/near";

import type { NearContext } from "../types";

export type DeleteKeysParams = NearContext & {
  nttAccount: string;
  /** The wasm the contract must be running — a build with `upgrade`. */
  wasmPath: string;
};

export type DeleteKeysResult = {
  txHash: string;
  /** Comma-separated. */
  deletedKeys: string;
  owner: string;
  codeSha256: string;
};

/**
 * Deletes every access key on the NTT contract account, in one transaction signed by the deployer
 * key `001` added. Afterwards the contract's `owner` is the only upgrade authority (`upgrade`), and
 * no key can sign `publish_message` as the contract's emitter — a message leaves this account only
 * through the contract.
 *
 * A contract with no keys and no `upgrade` can never be changed again, so this refuses unless the
 * code on chain is `wasmPath` — the build this repo's `upgrade` is in.
 *
 * @param params Deployer wallet (its key is on the NTT account), NTT contract account, its wasm
 * @returns The transaction, the keys it deleted, and who holds the upgrade authority now
 */
export async function deleteKeys(params: DeleteKeysParams): Promise<DeleteKeysResult> {
  const { provider, signer, nttAccount, wasmPath } = params;

  const codeSha256 = createHash("sha256").update(readFileSync(wasmPath)).digest("hex");
  const { code_hash } = await provider.viewAccount({ accountId: nttAccount });
  const onChain = Buffer.from(baseDecode(code_hash)).toString("hex");
  if (onChain !== codeSha256) {
    throw new Error(
      `${nttAccount} runs code ${onChain}, not ${wasmPath} (${codeSha256}). Deleting its keys ` +
        `could leave code without \`upgrade\` that nobody can change — upgrade it first.`,
    );
  }
  const owner = await view<string>(provider, nttAccount, "owner");

  const { keys } = await provider.viewAccessKeyList({
    accountId: nttAccount,
    finalityQuery: { finality: "final" },
  });
  const signerKey = (await signer.getPublicKey()).toString();
  const others = keys.map((k) => k.public_key).filter((k) => k !== signerKey);
  if (others.length === keys.length) {
    throw new Error(`${nttAccount} does not hold the deployer key ${signerKey} — cannot sign as it`);
  }

  // The signing key goes last; a transaction may delete the key that signed it.
  const deletedKeys = [...others, signerKey];
  const ntt = new Account(nttAccount, provider, signer);
  const outcome = await ntt.signAndSendTransaction({
    receiverId: nttAccount,
    actions: deletedKeys.map((k) => actions.deleteKey(PublicKey.fromString(k))),
    waitUntil: "FINAL",
  });
  checked("delete keys", outcome);

  const left = await provider.viewAccessKeyList({
    accountId: nttAccount,
    finalityQuery: { finality: "final" },
  });
  if (left.keys.length > 0) {
    throw new Error(`${nttAccount} still has keys: ${left.keys.map((k) => k.public_key).join(", ")}`);
  }

  return { txHash: outcome.transaction.hash, deletedKeys: deletedKeys.join(","), owner, codeSha256 };
}
