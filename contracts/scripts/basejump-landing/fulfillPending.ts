/**
 * Pays the landing's queue from the head with `fulfillPending()`, one call per queued entry, and
 * prints each receipt's landing events. Stops at the first call that reverts.
 *
 *   --park                 send `parkPending()` once instead: it pays the head if its dispatch
 *                          succeeds, otherwise moves it to `parkedTransfers` (TransferParked) and
 *                          advances the head; it reverts on an unfunded head.
 *   --fulfill-parked <id>  send `fulfillParked(id)`: pays a parked entry once its dispatch succeeds
 *                          (ParkedTransferFulfilled); reverts and leaves it parked otherwise.
 */
import "dotenv/config";

import { isAddress, parseEventLogs, type Abi, type TransactionReceipt } from "viem";

import { args } from "@whm/common";
import { ifs, wallet } from "@whm/common/evm";

import basejumpLandingJson from "../../out/BasejumpLanding.sol/BasejumpLanding.json";

const { optionalArg, requiredArg, requiredEnv } = args;
const { getWallet } = wallet;

function getConfig() {
  const rpcUrl = requiredEnv("RPC");
  const chainId = requiredEnv("CHAIN_ID");

  const privateKey = process.env.PK_LANDING || process.env.PK || requiredArg("--pk");
  const proxy = requiredArg("--proxy");

  if (!isAddress(proxy)) throw new Error("Invalid proxy address.");

  const parkedId = optionalArg("--fulfill-parked");
  if (parkedId !== undefined && !/^\d+$/.test(parkedId)) throw new Error("Invalid --fulfill-parked id.");

  return {
    rpcUrl,
    chainId: Number(chainId),
    privateKey: privateKey as `0x${string}`,
    proxy: proxy as `0x${string}`,
    park: process.argv.includes("--park"),
    parkedId: parkedId === undefined ? undefined : BigInt(parkedId),
  };
}

/** The landing's events in a receipt: TransferParked, PendingTransferFulfilled, ParkedTransferFulfilled, ... */
function printEvents(abi: Abi, proxy: string, receipt: TransactionReceipt): void {
  const logs = parseEventLogs({ abi, logs: receipt.logs }).filter(
    (l) => l.address.toLowerCase() === proxy.toLowerCase(),
  );
  if (logs.length === 0) console.log("     events: none");
  for (const l of logs) {
    const a = l.args as Record<string, unknown>;
    console.log(`     event ${l.eventName}${"id" in a ? ` id=${a.id}` : ""}${"amount" in a ? ` amount=${a.amount}` : ""}`);
  }
}

async function main() {
  const config = getConfig();
  const { publicClient, walletClient } = getWallet(
    config.rpcUrl,
    config.chainId,
    config.privateKey,
  );
  const { abi } = basejumpLandingJson as ifs.ContractArtifact;

  if (config.parkedId !== undefined) {
    const id = config.parkedId;
    const pt = (await publicClient.readContract({
      address: config.proxy,
      abi,
      functionName: "parkedTransfers",
      args: [id],
    })) as [string, bigint, string];
    console.log(`Parked [${id}] sourceAsset=${pt[0]} amount=${pt[1]} recipient=${pt[2]}`);
    console.log("     fulfillParked...");
    const hash = await walletClient.writeContract({
      address: config.proxy,
      abi,
      functionName: "fulfillParked",
      args: [id],
      gas: 1_000_000n,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`     Tx: ${receipt.transactionHash} (status: ${receipt.status})`);
    printEvents(abi as Abi, config.proxy, receipt);
    return;
  }

  const head = (await publicClient.readContract({
    address: config.proxy,
    abi,
    functionName: "pendingHead",
  })) as bigint;
  const tail = (await publicClient.readContract({
    address: config.proxy,
    abi,
    functionName: "pendingTail",
  })) as bigint;

  console.log(`Pending: ${tail - head} (head=${head}, tail=${tail})`);

  if (head >= tail) {
    console.log("No pending transfers.");
    return;
  }

  for (let i = head; i < tail; i++) {
    const pt = (await publicClient.readContract({
      address: config.proxy,
      abi,
      functionName: "pendingTransfers",
      args: [i],
    })) as [string, bigint, string];
    console.log(`\n[${i}] sourceAsset=${pt[0]} amount=${pt[1]} recipient=${pt[2]}`);

    const destAsset = (await publicClient.readContract({
      address: config.proxy,
      abi,
      functionName: "destAssetFor",
      args: [pt[0]],
    })) as string;
    console.log(`     destAsset=${destAsset}`);

    // parkPending hands the dispatch a fixed 500k gas and requires a bit over 518k left, so
    // 1M covers it.
    const fn = config.park ? "parkPending" : "fulfillPending";
    console.log(`     ${fn}...`);
    const hash = await walletClient.writeContract({
      address: config.proxy,
      abi,
      functionName: fn,
      gas: 1_000_000n,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`     Tx: ${receipt.transactionHash} (status: ${receipt.status})`);
    printEvents(abi as Abi, config.proxy, receipt);
    if (receipt.status !== "success") {
      console.log("     Reverted; stopping. A funded head whose dispatch fails for good: run with --park.");
      return;
    }
    if (config.park) return;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
