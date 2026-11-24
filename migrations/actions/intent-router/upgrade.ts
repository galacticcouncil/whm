import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { baseDecode, teraToGas } from "near-api-js";
import { call, checked, view } from "@whm/common/near";

import type { NearContext } from "../types";

export type UpgradeRouterParams = NearContext & {
  /** The router account. */
  router: string;
  /** The build to run — `cargo near build` of crates/near/contracts/intent-router. */
  wasmPath: string;
};

export type UpgradeRouterResult = {
  txHash: string;
  routerAccount: string;
  codeSha256: string;
};

/**
 * Upgrades the intent router: its owner calls `upgrade` with the wasm as raw input, which deploys it
 * and runs the new code's `migrate` in one batch, 1 yocto. The code on chain is then read back and
 * must be the wasm's.
 *
 * @param params The owner's wallet, the router, the wasm
 * @returns The upgrade transaction and the code hash now on chain
 */
export async function upgradeRouter(params: UpgradeRouterParams): Promise<UpgradeRouterResult> {
  const { account, provider, router, wasmPath } = params;
  const code = readFileSync(wasmPath);
  const codeSha256 = createHash("sha256").update(code).digest("hex");

  const owner = await view<string>(provider, router, "owner");
  if (owner !== account.accountId) throw new Error(`intent-router is owned by ${owner}, not ${account.accountId}`);

  const outcome = checked(
    "upgrade intent-router",
    await call(account, router, "upgrade", new Uint8Array(code), { deposit: 1n, gas: teraToGas(300) }),
  );

  const { code_hash } = await provider.viewAccount({ accountId: router });
  const onChain = Buffer.from(baseDecode(code_hash)).toString("hex");
  if (onChain !== codeSha256) throw new Error(`intent-router runs ${onChain}, not ${codeSha256}`);

  return { txHash: outcome.transaction.hash, routerAccount: router, codeSha256 };
}
