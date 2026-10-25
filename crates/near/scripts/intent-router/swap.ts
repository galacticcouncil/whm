import "dotenv/config";

import { teraToGas } from "near-api-js";

import { args } from "@whm/common";
import { call, events, view, type TxOutcome } from "@whm/common/near";

import { signedFields, type QuoteResponse } from "./oneclick";
import { gasReport } from "../utxo-withdraw/shared";
import { balances, bytesArg, derive, intentSigned, oneClick, parseOrderVaa, sleep, type Config } from "./shared";
import { run, signer } from "../ntt-manager/shared";

const { optionalArg, requiredArg } = args;

/**
 * One swap round, as the bot runs it: size the fill (`A`'s ETH, capped at `max_fill_multiple` × the
 * order's amount), get a 1Click quote paying and refunding `A`, have the router check and sign the
 * transfer to its deposit account, submit through 1Click, follow the status. Needs ONECLICK_KEY.
 *
 * Usage: ONECLICK_KEY=… tsx swap.ts --contract <router> --terms <hex|base64> --vaa <hex|base64>
 *          [--slippage <bps, 1Click's>] [--no-submit] --account <bot> --pk <ed25519:…>
 */
async function main(): Promise<void> {
  const { account: bot, provider } = signer();
  const contract = requiredArg("--contract");
  const terms = bytesArg(requiredArg("--terms"));
  const vaa = bytesArg(requiredArg("--vaa"));

  const config = await view<Config>(provider, contract, "get_config");
  const d = await derive(provider, contract, terms);
  const order = parseOrderVaa(vaa);
  if (order.authPath !== d.path) throw new Error(`the order is for ${order.authPath}, the terms for ${d.path}`);
  const destination = terms.subarray(81, 81 + terms[80]).toString("utf8");

  const held = (await balances(provider, config.intents, d.account, [config.eth_token]))[config.eth_token];
  const cap = order.amount * BigInt(config.params.max_fill_multiple);
  const amount = held < cap ? held : cap;
  console.log(`account ${d.account}: ${held} wei; order ${order.seq} sent ${order.amount}, filling ${amount}`);
  if (amount === 0n) throw new Error("nothing to swap yet — POA has not credited A");

  const q = await oneClick<QuoteResponse>("/v0/quote", {
    dry: false,
    swapType: "EXACT_INPUT",
    slippageTolerance: Number(optionalArg("--slippage") ?? "100"),
    originAsset: config.eth_token,
    depositType: "INTENTS",
    destinationAsset: destination,
    amount: amount.toString(),
    refundTo: d.account,
    refundType: "INTENTS",
    recipient: d.account,
    recipientType: "INTENTS",
    deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  console.log(`quote ${q.quote.amountIn} → ${q.quote.amountOut} (min ${q.quote.minAmountOut}), deposit ${q.quote.depositAddress}`);

  const quote = { signed: signedFields(q), signature: q.signature };
  let outcome: TxOutcome;
  try {
    outcome = await call(
      bot,
      contract,
      "swap",
      { terms: terms.toString("base64"), order_vaa: vaa.toString("base64"), quote },
      { deposit: 1n, gas: teraToGas(300) },
    );
  } catch (error) {
    const failed = (error as { transactionResult?: TxOutcome }).transactionResult;
    if (failed) gasReport("swap", failed);
    throw error;
  }
  gasReport("swap", outcome);
  const signed = intentSigned(outcome, events);
  console.log("signed", JSON.stringify({ ...signed, signed_data: undefined }));
  if (process.argv.includes("--no-submit")) return console.log(JSON.stringify(signed.signed_data));

  const s = await oneClick<{ intentHash: string }>("/v0/submit-intent", { type: "swap_transfer", signedData: signed.signed_data });
  console.log(`submitted, intent ${s.intentHash}`);
  for (let last = "", start = Date.now(); Date.now() - start < 10 * 60_000; await sleep(5_000)) {
    const st = await oneClick<{ status: string }>(`/v0/status?depositAddress=${encodeURIComponent(q.quote.depositAddress!)}`);
    if (st.status !== last) console.log(`  +${((Date.now() - start) / 1000).toFixed(0)}s ${(last = st.status)}`);
    if (["SUCCESS", "REFUNDED", "FAILED"].includes(st.status)) break;
  }
}

run(main);
