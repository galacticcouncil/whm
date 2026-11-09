import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { actions, teraToGas } from "near-api-js";
import { checked, view } from "@whm/common/near";

import type { NearContext } from "../types";

export type DeployWithdrawParams = NearContext & {
  /** Sub-account prefix — the contract lands on `<prefix>.<deployer>`. */
  prefix: string;
  /** NEAR moved to the new account, yocto — covers the code's storage. */
  balance: bigint;
  wasmPath: string;
  /** `Chain` variant, e.g. `Zcash` or `ZcashTestnet`. */
  chain: string;
  /** What the connector's `get_config().chain` must say for this `chain`. */
  connectorChain: string;
  mpcSigner: string;
  token: string;
  connector: string;
  validity: number;
  withdrawTgas: number;
};

export type DeployWithdrawResult = {
  txHash: string;
  withdrawAccount: string;
  owner: string;
  codeSha256: string;
  chain: string;
};

type ConnectorConfig = { chain: string; nbtc_account_id: string; change_address: string | null };

/**
 * Creates `<prefix>.<deployer>`, funds it, deploys `utxo-withdraw` and initialises it — one
 * transaction, so a failure leaves no half-created account. The deployer owns the contract and
 * keeps a full-access key on it until ownership and keys are handed over.
 *
 * The connector is checked first: it must serve `connectorChain`, withdraw `token`, and have a
 * change address — the contract would refuse every withdrawal otherwise.
 *
 * The account id is the derivation predecessor of every withdraw account this contract signs for:
 * it is the deployment's identity, and never changes once users send to it.
 *
 * @param params Deployer wallet, account prefix and balance, wasm path, chain and its endpoints, params
 * @returns The contract account, its owner and the code it runs
 */
export async function deployWithdraw(params: DeployWithdrawParams): Promise<DeployWithdrawResult> {
  const { account, provider, signer, prefix, balance, wasmPath } = params;

  const config = await view<ConnectorConfig>(provider, params.connector, "get_config");
  if (config.chain !== params.connectorChain) {
    throw new Error(`${params.connector} serves ${config.chain}, not ${params.connectorChain}`);
  }
  if (config.nbtc_account_id !== params.token) {
    throw new Error(`${params.connector} withdraws ${config.nbtc_account_id}, not ${params.token}`);
  }
  if (!config.change_address) {
    throw new Error(`${params.connector} has no change address configured`);
  }

  const withdrawAccount = `${prefix}.${account.accountId}`;
  const code = readFileSync(wasmPath);

  const outcome = await account.signAndSendTransaction({
    receiverId: withdrawAccount,
    actions: [
      actions.createAccount(),
      actions.transfer(balance),
      actions.addFullAccessKey(await signer.getPublicKey()),
      actions.deployContract(new Uint8Array(code)),
      actions.functionCall(
        "new",
        {
          owner: account.accountId,
          chain: params.chain,
          mpc_signer: params.mpcSigner,
          token: params.token,
          connector: params.connector,
          validity: params.validity,
          withdraw_tgas: params.withdrawTgas,
        },
        teraToGas(100),
        0n,
      ),
    ],
    waitUntil: "FINAL",
  });
  checked("deploy utxo-withdraw", outcome);

  return {
    txHash: outcome.transaction.hash,
    withdrawAccount,
    owner: account.accountId,
    codeSha256: createHash("sha256").update(code).digest("hex"),
    chain: params.chain,
  };
}
