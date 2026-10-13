import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { teraToGas } from "near-api-js";

import { args } from "@whm/common";
import { call } from "@whm/common/near";

import { report, run, signer } from "./shared";

const { requiredArg } = args;

/**
 * Upgrades the NTT contract: `upgrade` with the wasm as raw input, which deploys it and runs the new
 * code's `migrate` in one batch. Owner-only, 1 yocto.
 *
 * With `--print`, signs nothing and prints what a multisig proposal needs instead — receiver,
 * method, deposit, gas and the args (the wasm, base64).
 *
 * Usage: tsx upgrade.ts --contract <ntt> --wasm <path> --account <owner> --pk <ed25519:…>
 *        tsx upgrade.ts --contract <ntt> --wasm <path> --print
 */
run(async () => {
  const contract = requiredArg("--contract");
  const code = readFileSync(requiredArg("--wasm"));
  console.log(`code sha256 ${createHash("sha256").update(code).digest("hex")} (${code.length} bytes)`);

  if (process.argv.includes("--print")) {
    console.log(JSON.stringify({
      receiver_id: contract,
      method_name: "upgrade",
      deposit: "1",
      gas: teraToGas(300).toString(),
      args: code.toString("base64"),
    }));
    return;
  }

  const { account } = signer();
  report(await call(account, contract, "upgrade", new Uint8Array(code), { deposit: 1n, gas: teraToGas(300) }));
});
