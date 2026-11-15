import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { actions, teraToGas } from "near-api-js";
import { checked, view } from "@whm/common/near";

import type { NearContext } from "../types";

/** The router's `Params`, as `new` and `set_params` take them. */
export type RouterParams = {
  price_validity: number;
  max_quote_age: number;
  min_quote_slippage_bps: number;
  transfer_validity: number;
  max_order_shortfall_bps: number;
  /** Wei, decimal string. */
  min_refund: string;
};

export type DeployRouterParams = NearContext & {
  /** Sub-account prefix — the router lands on `<prefix>.<deployer>`, the MPC derivation predecessor. */
  prefix: string;
  /** NEAR moved to the new account, yocto — covers the code's storage. */
  balance: bigint;
  wasmPath: string;
  mpcSigner: string;
  intents: string;
  core: string;
  /** Wormhole chain id of the order emitter — Hydration, 73. */
  emitterChain: number;
  /** The IntentDispatcher proxy, `0x` + 32 bytes. */
  emitter: string;
  /** Intents ledger id of ETH, `nep141:eth.omft.near`. */
  ethToken: string;
  /** 1Click's quote-signing keys, `ed25519:<base58>`. */
  quoteKeys: string[];
  params: RouterParams;
};

export type DeployRouterResult = {
  txHash: string;
  routerAccount: string;
  owner: string;
  codeSha256: string;
  emitter: string;
};

/**
 * Creates `<prefix>.<deployer>`, funds it, deploys the intent router and initialises it — one
 * transaction, so nobody can call `new` first and own the derivation account. The deployer owns
 * the router and keeps a full-access key on it until the canary passes and ownership and keys are
 * handed over.
 *
 * @param params Deployer wallet, account prefix and balance, wasm, the router's `new` arguments
 * @returns The router account, its owner, and the code and emitter it was initialised with
 */
export async function deployRouter(params: DeployRouterParams): Promise<DeployRouterResult> {
  const { account, provider, signer, prefix, balance, wasmPath } = params;

  const routerAccount = `${prefix}.${account.accountId}`;
  const code = readFileSync(wasmPath);

  const outcome = await account.signAndSendTransaction({
    receiverId: routerAccount,
    actions: [
      actions.createAccount(),
      actions.transfer(balance),
      actions.addFullAccessKey(await signer.getPublicKey()),
      actions.deployContract(new Uint8Array(code)),
      actions.functionCall(
        "new",
        {
          owner: account.accountId,
          mpc_signer: params.mpcSigner,
          intents: params.intents,
          core: params.core,
          emitter_chain: params.emitterChain,
          emitter: params.emitter,
          eth_token: params.ethToken,
          quote_keys: params.quoteKeys,
          params: params.params,
        },
        teraToGas(100),
        0n,
      ),
    ],
    waitUntil: "FINAL",
  });
  checked("deploy intent-router", outcome);

  // Read back what the router holds, not what was sent.
  const owner = await view<string>(provider, routerAccount, "owner");
  if (owner !== account.accountId) throw new Error(`intent-router owner is ${owner}, expected ${account.accountId}`);

  return {
    txHash: outcome.transaction.hash,
    routerAccount,
    owner,
    codeSha256: createHash("sha256").update(code).digest("hex"),
    emitter: params.emitter,
  };
}
