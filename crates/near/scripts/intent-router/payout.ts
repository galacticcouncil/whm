import "dotenv/config";

import { teraToGas } from "near-api-js";

import { args } from "@whm/common";
import { call, events, type TxOutcome } from "@whm/common/near";

import { gasReport } from "../utxo-withdraw/shared";
import { bytesArg, intentSigned, jsonRpc, RELAY_RPC, sleep } from "./shared";
import { run, signer } from "../ntt-manager/shared";

const { requiredArg } = args;

/**
 * Has the router sign `A`'s delivery (its destination balance to the terms' recipient) or, after the
 * deadline, its refund (its ETH to `refundTo`), then publishes it on the solver relay — no quote
 * needed — and follows its status.
 *
 * Usage: tsx payout.ts --contract <router> --terms <hex|base64> --deliver|--refund [--no-publish]
 *          --account <bot> --pk <ed25519:…>
 */
async function main(): Promise<void> {
  const { account: bot } = signer();
  const contract = requiredArg("--contract");
  const terms = bytesArg(requiredArg("--terms"));
  const method = process.argv.includes("--refund") ? "refund" : process.argv.includes("--deliver") ? "deliver" : "";
  if (!method) throw new Error("pass --deliver or --refund");

  let outcome: TxOutcome;
  try {
    outcome = await call(bot, contract, method, { terms: terms.toString("base64") }, { deposit: 1n, gas: teraToGas(300) });
  } catch (error) {
    const failed = (error as { transactionResult?: TxOutcome }).transactionResult;
    if (failed) gasReport(method, failed);
    throw error;
  }
  gasReport(method, outcome);
  const signed = intentSigned(outcome, events);
  console.log("signed", JSON.stringify({ ...signed, signed_data: undefined }));
  if (process.argv.includes("--no-publish")) return console.log(JSON.stringify(signed.signed_data));

  const p = await jsonRpc<{ status: string; intent_hash?: string; reason?: string }>(RELAY_RPC, "publish_intent", {
    quote_hashes: [],
    signed_data: signed.signed_data,
  });
  console.log("publish", JSON.stringify(p));
  if (!p.intent_hash) return;
  for (let last = "", start = Date.now(); Date.now() - start < 5 * 60_000; await sleep(3_000)) {
    const s = await jsonRpc<{ status: string; data?: { hash?: string } }>(RELAY_RPC, "get_status", { intent_hash: p.intent_hash });
    if (s.status !== last) console.log(`  ${(last = s.status)}${s.data?.hash ? `  tx ${s.data.hash}` : ""}`);
    if (s.status === "SETTLED" || s.status === "NOT_FOUND_OR_NOT_VALID") break;
  }
}

run(main);
