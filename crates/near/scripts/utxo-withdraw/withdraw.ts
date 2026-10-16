import "dotenv/config";

import { actions, encodeSignedDelegate, teraToGas } from "near-api-js";

import { args } from "@whm/common";
import { call, events, view, type TxOutcome } from "@whm/common/near";

import { derive, gasReport, pickCoin, rebuild, type Params } from "./shared";
import { run, signer } from "../ntt-manager/shared";

const { optionalArg, requiredArg } = args;

/**
 * Asks the contract to sign `A`'s withdrawal (or, with `--claim`, its `claim_lost_found`), then
 * relays the signed delegate from this account — what the bot does. Creates `A` first if it does
 * not exist (1 yocto: an implicit account needs no balance). Prints gas per receipt for both
 * transactions, failed ones included.
 *
 * The coin to spend is picked off-chain by best fit over the connector's whole set (`--coin`
 * overrides it): reading coins on chain costs too much, and the pick touches only Omni's reserve.
 *
 * The emitted bytes are rebuilt into near-api-js's own `SignedDelegate` and re-encoded; the relay
 * refuses unless they match byte for byte.
 *
 * Usage: tsx withdraw.ts --contract <utxo-withdraw> --address <zcash address> [--claim] [--coin <txid:vout>]
 *          [--no-relay] --account <relayer> --pk <ed25519:…>
 */
async function main(): Promise<void> {
  const { account: relayer, provider } = signer();
  const contract = requiredArg("--contract");
  const address = requiredArg("--address");
  const method = process.argv.includes("--claim") ? "claim" : "withdraw";

  const derived = await derive(provider, contract, address);
  console.log("account", derived.account);

  const exists = await provider.viewAccount({ accountId: derived.account }).then(
    () => true,
    () => false,
  );
  if (!exists) {
    const created = await relayer.signAndSendTransaction({
      receiverId: derived.account,
      actions: [actions.transfer(1n)],
      waitUntil: "FINAL",
    });
    gasReport("create A", created);
  }

  let callArgs: object = { address };
  if (method === "withdraw") {
    const params = await view<Params>(provider, contract, "get_params");
    const coin = optionalArg("--coin") ?? (await pickCoin(provider, params, derived.account));
    console.log("coin", coin);
    callArgs = { address, coin };
  }

  let outcome: TxOutcome;
  try {
    outcome = await call(relayer, contract, method, callArgs, { deposit: 1n, gas: teraToGas(300) });
  } catch (error) {
    // near-api-js throws on a failed receipt; the outcome still says where the gas went.
    const failed = (error as { transactionResult?: TxOutcome }).transactionResult;
    if (failed) gasReport(method, failed);
    throw error;
  }
  gasReport(method, outcome);
  const signed = events(outcome, "whm-utxo-withdraw").find((e) => e.event === "signed");
  if (!signed) throw new Error("no signed event — see the failed receipts above");
  const data = (signed.data as Record<string, unknown>[])[0];
  console.log("signed", JSON.stringify({ ...data, signed_delegate: undefined }));

  const bytes = Buffer.from(data.signed_delegate as string, "base64");
  const delegate = rebuild(bytes);
  if (Buffer.compare(Buffer.from(encodeSignedDelegate(delegate)), bytes) !== 0) {
    throw new Error("rebuilt SignedDelegate does not re-encode to the emitted bytes");
  }

  if (process.argv.includes("--no-relay")) return;
  const relayed = await relayer.signAndSendTransaction({
    receiverId: derived.account,
    actions: [actions.signedDelegate(delegate)],
    waitUntil: optionalArg("--wait") === "final" ? "FINAL" : "EXECUTED_OPTIMISTIC",
  });
  gasReport("relay", relayed);
}

run(main);
