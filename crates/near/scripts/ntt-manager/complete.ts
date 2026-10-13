import { nearToYocto, teraToGas } from "near-api-js";

import { args } from "@whm/common";
import { call } from "@whm/common/near";
import { fetchVaaHex } from "@whm/common/wormhole";

import { report, run, signer } from "./shared";

const { optionalArg, optionalEnv, requiredArg } = args;

/** Wormhole chain id of Hydration. */
const HYDRATION = 73;

/**
 * Hydration → NEAR: redeem an NTT VAA on the NEAR contract. Anyone may call; the tokens go to the
 * account the VAA names, which must be `--recipient` (default: the signer).
 *
 * The VAA comes from `--vaa` (hex or base64), or is fetched from Wormholescan by the Hydration
 * transceiver's `--emitter` and `--sequence`. The 0.01 NEAR deposit covers a first-time recipient's
 * token registration and the replay entry; the rest is refunded.
 *
 * Usage: tsx complete.ts --contract <ntt> (--vaa <vaa> | --emitter <32-byte hex> --sequence <n>)
 *                        [--recipient <account>] --account <signer> --pk <ed25519:…>
 */
run(async () => {
  const contract = requiredArg("--contract");
  const { account } = signer();
  const recipient = optionalArg("--recipient") ?? account.accountId;

  const vaa = await resolveVaa();
  const outcome = await call(
    account,
    contract,
    "complete",
    { vaa, account_id: recipient },
    { deposit: nearToYocto("0.01"), gas: teraToGas(150) },
  );
  report(outcome);
});

/**
 * The VAA as plain hex — what `complete` takes.
 *
 * @returns Hex, no `0x`
 */
async function resolveVaa(): Promise<string> {
  const given = optionalArg("--vaa");
  if (given) {
    return given.startsWith("0x") ? given.slice(2) : Buffer.from(given, "base64").toString("hex");
  }
  const emitter = requiredArg("--emitter").replace(/^0x/, "").padStart(64, "0");
  const sequence = BigInt(requiredArg("--sequence"));
  const hex = await fetchVaaHex(HYDRATION, emitter, sequence, optionalEnv("WORMHOLE_API_KEY"));
  return hex.slice(2);
}
