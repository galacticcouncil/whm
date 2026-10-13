import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { actions, teraToGas } from "near-api-js";
import { accountHash, checked, view } from "@whm/common/near";

import type { NearContext } from "../types";

export type DeployNttParams = NearContext & {
  /** Sub-account prefix — the contract lands on `<prefix>.<deployer>`. */
  prefix: string;
  /** NEAR moved to the new account, yocto — covers the code's storage. */
  balance: bigint;
  wasmPath: string;
  token: string;
  core: string;
  /** Outbound limit, token units. */
  outboundLimit: string;
};

export type DeployNttResult = {
  txHash: string;
  nttAccount: string;
  emitter: string;
  owner: string;
  codeSha256: string;
  tokenDecimals: string;
  registrationDeposit: string;
};

type StorageBalanceBounds = { min: string; max: string | null };
type FtMetadata = { decimals: number };

/**
 * Creates `<prefix>.<deployer>`, funds it, deploys `ntt-manager` and initialises it — one
 * transaction, so a failure leaves no half-created account. The deployer owns the contract (it
 * wires peers next) and keeps a full-access key on it until ownership and keys are handed over.
 *
 * `token_decimals` and `registration_deposit` are read from the token itself, not configured: the
 * contract must agree with the token on both, and the token is the one source of truth.
 *
 * @param params Deployer wallet, account prefix and balance, wasm path, token, core, outbound limit
 * @returns The contract account, its Wormhole emitter, and what it was initialised with
 */
export async function deployNtt(params: DeployNttParams): Promise<DeployNttResult> {
  const { account, provider, signer, prefix, balance, wasmPath, token, core, outboundLimit } = params;

  const nttAccount = `${prefix}.${account.accountId}`;
  const code = readFileSync(wasmPath);
  const { decimals } = await view<FtMetadata>(provider, token, "ft_metadata");
  const bounds = await view<StorageBalanceBounds>(provider, token, "storage_balance_bounds");

  const outcome = await account.signAndSendTransaction({
    receiverId: nttAccount,
    actions: [
      actions.createAccount(),
      actions.transfer(balance),
      actions.addFullAccessKey(await signer.getPublicKey()),
      actions.deployContract(new Uint8Array(code)),
      actions.functionCall(
        "new",
        {
          owner: account.accountId,
          token,
          token_decimals: decimals,
          registration_deposit: bounds.min,
          core,
          outbound_limit: outboundLimit,
        },
        teraToGas(100),
        0n,
      ),
    ],
    waitUntil: "FINAL",
  });
  checked("deploy ntt-manager", outcome);

  return {
    txHash: outcome.transaction.hash,
    nttAccount,
    emitter: accountHash(nttAccount),
    owner: account.accountId,
    codeSha256: createHash("sha256").update(code).digest("hex"),
    tokenDecimals: String(decimals),
    registrationDeposit: bounds.min,
  };
}
