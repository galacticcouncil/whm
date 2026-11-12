import "dotenv/config";

import { JsonRpcProvider } from "near-api-js";

import { args } from "@whm/common";
import { view } from "@whm/common/near";

import { balances, bytesArg, derive, encodeTerms, newQuoteId, type Config } from "./shared";
import { run } from "../ntt-manager/shared";

const { optionalArg, requiredArg, requiredEnv } = args;

/**
 * Read-only: an action's account — the terms, path, `A`, POA's ETH deposit address `0xN` — and
 * what `A` holds. Takes encoded terms, or builds new ones (random `quoteId`) from their fields.
 *
 * Usage: tsx derive.ts --contract <router> --terms <hex|base64>
 *        tsx derive.ts --contract <router> --owner <0x…> --asset <ledger id> --recipient <address>
 *          --refund-to <0x…> --deadline <unix s> --min-delivery <destination units> [--slippage <bps>]
 *          [--min-rate <units per 1e18 wei>] [--intents]
 */
async function main(): Promise<void> {
  const provider = new JsonRpcProvider({ url: requiredEnv("RPC_NEAR") });
  const contract = requiredArg("--contract");
  const given = optionalArg("--terms");
  const terms = given
    ? bytesArg(given)
    : encodeTerms({
        owner: requiredArg("--owner"),
        quoteId: newQuoteId(),
        maxSlippageBps: Number(optionalArg("--slippage") ?? "100"),
        minOutPerIn: BigInt(optionalArg("--min-rate") ?? "0"),
        minDelivery: BigInt(requiredArg("--min-delivery")),
        deadline: BigInt(requiredArg("--deadline")),
        recipientKind: process.argv.includes("--intents") ? 1 : 0,
        refundTo: requiredArg("--refund-to"),
        destinationAsset: requiredArg("--asset"),
        recipient: requiredArg("--recipient"),
      });

  const config = await view<Config>(provider, contract, "get_config");
  const d = await derive(provider, contract, terms);
  console.log("terms      ", terms.toString("hex"));
  console.log("path       ", d.path);
  console.log("key        ", d.publicKey);
  console.log("account A  ", d.account);
  console.log("deposit 0xN", d.depositAddress);

  const destination = terms.subarray(117, 117 + terms[116]).toString("utf8");
  const held = await balances(provider, config.intents, d.account, [config.eth_token, destination]);
  console.log("balances   ", Object.entries(held).map(([t, v]) => `${v} ${t}`).join(", "));
}

run(main);
