import "dotenv/config";

import { isAddress, parseEventLogs } from "viem";

import { OneClickService } from "@defuse-protocol/one-click-sdk-typescript";

import { args } from "@whm/common";
import { ifs, wallet } from "@whm/common/evm";

import intentReceiverJson from "../out/IntentReceiver.sol/IntentReceiver.json";

const { requiredArg, optionalArg, requiredEnv, optionalEnv } = args;
const { getWallet } = wallet;

/**
 * NIR (Near Intent Routing) leg-2 — relay-only driver, starting from an existing VAA.
 *
 * Skips the 1Click quote + Moonbeam bridge (see nirViaWtt.ts for the full flow). Takes a signed
 * payload-3 TokenBridge VAA (`transferTokensWithPayload`) already addressed to the IntentReceiver and
 * runs just the Ethereum relay step — exactly what the live relayer (mrelayer/app-intent) does:
 *
 *   IntentReceiver.redeem(vaa, feeRequested) → completeTransferWithPayload, unwrap WETH → native ETH,
 *   pay the relayer feeRequested, forward the rest to the payload's OneClick depositAddress; then
 *   notify 1Click so it detects the deposit faster.
 *
 * feeRequested defaults to the quoter service at marginBps=0 (the relayer's real cost), which must be
 * ≤ the maxRelayFee ceiling baked into the VAA payload (the UI sets that to quote + 20% headroom) or
 * redeem reverts FeeExceedsCeiling. Pass --feeRequested to override (e.g. 0 to forward everything and
 * eat the gas yourself).
 *
 * Env:  ETH_RPC, ETH_CHAIN_ID; QUOTER_URL?
 * Args: --pk --receiver(IntentReceiver) --vaa(0x… payload-3 VAA)  [--feeRequested(wei)]
 */
async function main(): Promise<void> {
  const privateKey = requiredArg("--pk") as `0x${string}`;
  const receiver = requiredArg("--receiver"); // IntentReceiver (Ethereum)
  const vaa = requiredArg("--vaa") as `0x${string}`; // signed payload-3 VAA

  if (!isAddress(receiver)) throw new Error("Invalid --receiver (IntentReceiver).");
  if (!vaa.startsWith("0x")) throw new Error("--vaa must be 0x-prefixed hex.");

  const ethRpc = requiredEnv("ETH_RPC");
  const ethChainId = Number(requiredEnv("ETH_CHAIN_ID"));
  const { publicClient, walletClient } = getWallet(ethRpc, ethChainId, privateKey);
  const { abi: receiverAbi } = intentReceiverJson as ifs.ContractArtifact;

  // Relayer's ask: the quoter at marginBps=0 (real cost), same as the live relayer. Bounded by the
  // VAA payload's maxRelayFee ceiling. Override with --feeRequested (0 ⇒ forward 100%, no fee).
  const feeOverride = optionalArg("--feeRequested");
  let feeRequested: bigint;
  if (feeOverride !== undefined) {
    feeRequested = BigInt(feeOverride);
  } else {
    const quoterUrl = optionalEnv("QUOTER_URL") || "https://quoter-api.play.hydration.cloud";
    const res = await fetch(`${quoterUrl}/relay-fee?chain=ethereum&marginBps=0`);
    if (!res.ok) throw new Error(`quoter ${res.status}: ${await res.text()}`);
    const { feeRequested: quoted } = (await res.json()) as { feeRequested: string };
    feeRequested = BigInt(quoted);
    console.log(`feeRequested=${feeRequested} (quoter ${quoterUrl}, marginBps=0)`);
  }

  console.log(`Redeeming VAA on IntentReceiver ${receiver} (feeRequested=${feeRequested})…`);
  const relayTx = await walletClient.writeContract({
    address: receiver as `0x${string}`,
    abi: receiverAbi,
    functionName: "redeem",
    args: [vaa, feeRequested],
    gas: 2_000_000n,
  });
  const relayReceipt = await publicClient.waitForTransactionReceipt({ hash: relayTx });
  console.log(`redeem: tx=${relayReceipt.transactionHash} status=${relayReceipt.status}`);

  // redeem forwards (and emits IntentForwarded) atomically or reverts — there is no queue here.
  const forwarded = parseEventLogs({
    abi: receiverAbi,
    eventName: "IntentForwarded",
    logs: relayReceipt.logs,
  })[0];
  if (!forwarded) {
    throw new Error("redeem succeeded but no IntentForwarded event — investigate.");
  }
  const { depositAddress, amount, asset } = forwarded.args as {
    depositAddress: string;
    amount: bigint;
    asset: string;
  };
  console.log(`IntentForwarded → ${depositAddress} amount=${amount} asset=${asset} (tx ${relayTx})`);

  // Notify 1Click that the deposit landed (best-effort — it auto-detects regardless).
  try {
    const submit = await OneClickService.submitDepositTx({ depositAddress, txHash: relayTx });
    console.log("submitDepositTx:", JSON.stringify(submit, null, 2));
  } catch (e) {
    console.warn(`submitDepositTx failed (deposit still auto-detected): ${(e as Error).message}`);
  }
  console.log(`\nDone. Track 1Click status for ${depositAddress}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
