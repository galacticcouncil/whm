import "dotenv/config";

import { randomBytes } from "node:crypto";

import { erc20Abi, isAddress, keccak256, parseEventLogs, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { args } from "@whm/common";
import { ifs, wallet } from "@whm/common/evm";

import intentDispatcherJson from "../out/IntentDispatcher.sol/IntentDispatcher.json";

const { requiredArg, optionalArg, requiredEnv, optionalEnv } = args;
const { getWallet } = wallet;

const NEAR_RPC = "https://free.rpc.fastnear.com";
const POA_RPC = "https://bridge.chaindefuser.com/rpc";
const QUOTER_URL = "https://quoter-intent.play.hydration.cloud";

const MPC_SIGNER = "v1.signer";
const INTENTS = "intents.near";
const ETH_TOKEN_ID = "nep141:eth.omft.near";
const DESTINATION = "nep141:zec.omft.near";

/** Hydration WETH's ERC20 precompile: 0x0100000000 | 20. */
const WETH = "0x0000000000000000000000000000000100000014";

const KIND = { withdraw: 0, intents: 1 } as const;
const BPS = 10_000n;

/**
 * Intents v2 canary — one single-swap order through the dispatcher's direct `dispatch`, followed to
 * its delivery.
 *
 *   1. Terms: owner and refundTo the signer, a fresh quoteId, maxFillMultiplier 2, the hard floor
 *      --floorBps under the dispatcher's live `outPerIn`, deadline --deadlineHours out. Encoded by the
 *      dispatcher (`computeTerms`) — the bytes the router hashes.
 *   2. A: `v1.signer.derived_public_key(authPath, router, 1)`; POA's deposit address for it.
 *   3. maxRelayFee: the quoter, +20%.
 *   4. approve WETH + dispatch(amount, depositAddress, maxRelayFee, terms).
 *   5. Follow: scan's order (published → forwarded), then A's ETH and ZEC until it is delivered.
 *
 * The relayer's `intent-v2` app forwards on Ethereum, POA credits A, and the router bot swaps through
 * 1Click and delivers — so the canary tests all three. `--refundTest` sets the hard floor ten times
 * above the market and the deadline 20 minutes out: nothing fills, and the bot refunds the ETH to the
 * signer on Ethereum.
 *
 * Env: RPC, CHAIN_ID (Hydration); NEAR_RPC?, QUOTER_URL?, SCAN_API? (the scan `intents-v2` app),
 *      POA_RPC?, POA_API_KEY? (sent as a bearer token when POA refuses anonymous calls)
 * Args: --pk --dispatcher --router --amount(WETH wei) --recipient
 *       --kind? (intents | withdraw; default intents — a NEAR intents account, no POA withdrawal)
 *       --slippageBps? (default 300) --floorBps? (default 2000) --minDelivery? (default 1)
 *       --deadlineHours? (default 6) --refundTest? --wait? (minutes to follow; default 60)
 */

/**
 * Read-only NEAR contract call.
 *
 * @param accountId Contract to read.
 * @param methodName View method.
 * @param callArgs JSON args.
 * @returns The method's JSON return value.
 */
async function nearView<T>(accountId: string, methodName: string, callArgs: unknown): Promise<T> {
  const res = await fetch(optionalEnv("NEAR_RPC") ?? NEAR_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: accountId,
        method_name: methodName,
        args_base64: Buffer.from(JSON.stringify(callArgs)).toString("base64"),
      },
    }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`near rpc: ${JSON.stringify(body.error)}`);
  if (body.result?.error) throw new Error(`near view ${accountId}.${methodName}: ${body.result.error}`);
  return JSON.parse(Buffer.from(body.result.result).toString()) as T;
}

/**
 * base58-decode.
 *
 * @param input Base58 text.
 * @returns Its bytes.
 */
function b58decode(input: string): Uint8Array {
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let acc = 0n;
  for (const char of input) acc = acc * 58n + BigInt(B58.indexOf(char));
  const out: number[] = [];
  while (acc > 0n) {
    out.unshift(Number(acc & 0xffn));
    acc >>= 8n;
  }
  for (const char of input) {
    if (char !== "1") break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}

/**
 * POA's deposit address for an intents account, on Ethereum.
 *
 * @param accountId `A`.
 * @returns The H160 POA credits `A` from.
 */
async function depositAddress(accountId: string): Promise<`0x${string}`> {
  const key = optionalEnv("POA_API_KEY");
  const res = await fetch(optionalEnv("POA_RPC") ?? POA_RPC, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({
      id: "1",
      jsonrpc: "2.0",
      method: "deposit_address",
      params: [{ account_id: accountId, chain: "eth:1" }],
    }),
  });
  if (!res.ok) throw new Error(`poa ${res.status} — set POA_API_KEY if it refuses anonymous calls`);
  const body = await res.json();
  if (body.error) throw new Error(`poa rpc: ${JSON.stringify(body.error)}`);
  const address = body.result.address as string;
  if (!isAddress(address)) throw new Error(`POA returned a non-address: ${address}`);
  return address;
}

async function main(): Promise<void> {
  const privateKey = requiredArg("--pk") as `0x${string}`;
  const dispatcher = requiredArg("--dispatcher") as `0x${string}`;
  const router = requiredArg("--router");
  const amount = BigInt(requiredArg("--amount"));
  const recipient = requiredArg("--recipient");
  const kind = (optionalArg("--kind") ?? "intents") as keyof typeof KIND;
  const slippageBps = Number(optionalArg("--slippageBps") ?? "300");
  const floorBps = BigInt(optionalArg("--floorBps") ?? "2000");
  const minDelivery = BigInt(optionalArg("--minDelivery") ?? "1");
  const refundTest = process.argv.includes("--refundTest");
  const deadlineHours = Number(optionalArg("--deadlineHours") ?? "6");
  const waitMinutes = Number(optionalArg("--wait") ?? "60");

  if (!isAddress(dispatcher)) throw new Error("Invalid --dispatcher.");
  if (!(kind in KIND)) throw new Error("--kind is intents or withdraw.");

  const { publicClient, walletClient } = getWallet(requiredEnv("RPC"), Number(requiredEnv("CHAIN_ID")), privateKey);
  const signer = privateKeyToAccount(privateKey).address;
  const { abi } = intentDispatcherJson as ifs.ContractArtifact;
  const read = <T>(functionName: string, a: unknown[]) =>
    publicClient.readContract({ address: dispatcher, abi, functionName, args: a }) as Promise<T>;

  // 1. Terms. The hard floor is the only price the user commits to; the order's own price comes from
  //    the feeds at dispatch, and the router holds every fill within maxSlippageBps of it.
  const market = await read<bigint>("outPerIn", [DESTINATION]);
  const minOutPerIn = refundTest ? market * 10n : (market * (BPS - floorBps)) / BPS;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + (refundTest ? 20 * 60 : deadlineHours * 3600));
  const terms = {
    owner: signer,
    quoteId: `0x${randomBytes(32).toString("hex")}` as Hex,
    maxSlippageBps: slippageBps,
    maxFillMultiplier: 2,
    minOutPerIn,
    minDelivery,
    deadline,
    recipientKind: KIND[kind],
    refundTo: signer,
    destinationAsset: DESTINATION,
    recipient,
  };
  const encoded = await read<Hex>("computeTerms", [terms]);
  const authPath = await read<Hex>("computeAuthPath", [terms]);
  if (keccak256(encoded) !== authPath) throw new Error("computeAuthPath is not keccak256(computeTerms)");
  console.log(`1. terms     ${encoded}`);
  console.log(`   authPath  ${authPath}`);
  console.log(`   outPerIn  ${market} now; hard floor ${minOutPerIn}${refundTest ? " (refund test: unreachable)" : ""}`);
  console.log(`   deadline  ${new Date(Number(deadline) * 1000).toISOString()}`);

  // 2. A, and where POA credits it from.
  const publicKey = await nearView<string>(MPC_SIGNER, "derived_public_key", {
    path: authPath,
    predecessor: router,
    domain_id: 1,
  });
  const account = Buffer.from(b58decode(publicKey.replace("ed25519:", ""))).toString("hex");
  const deposit = await depositAddress(account);
  console.log(`2. A         ${account}`);
  console.log(`   deposit   ${deposit}`);

  // 3. The relay ceiling — the same +20% the SDK asks for.
  const quoter = optionalEnv("QUOTER_URL") ?? QUOTER_URL;
  const feeRes = await fetch(`${quoter}/relay-fee?chain=ethereum&marginBps=2000`);
  if (!feeRes.ok) throw new Error(`quoter ${feeRes.status}: ${await feeRes.text()}`);
  const maxRelayFee = BigInt(((await feeRes.json()) as { feeRequested: string }).feeRequested);
  console.log(`3. maxRelayFee ${maxRelayFee} wei`);

  // 4. Dispatch. Simulated first, so a floor the dispatcher enforces fails with its own error name.
  const approve = await walletClient.writeContract({
    address: WETH,
    abi: erc20Abi,
    functionName: "approve",
    args: [dispatcher, amount],
  });
  await publicClient.waitForTransactionReceipt({ hash: approve });
  const { request } = await publicClient.simulateContract({
    account: walletClient.account,
    address: dispatcher,
    abi,
    functionName: "dispatch",
    args: [amount, deposit, maxRelayFee, terms],
  });
  const tx = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  const published = parseEventLogs({ abi, eventName: "OrderPublished", logs: receipt.logs })[0];
  const { seq, amount: orderAmount } = (published?.args ?? {}) as { seq?: bigint; amount?: bigint };
  console.log(`4. dispatch  ${tx}`);
  console.log(`   seq ${seq}, A receives at least ${orderAmount} wei`);

  // 5. Follow it: scan for the Ethereum leg, A's balances for NEAR.
  const scan = optionalEnv("SCAN_API");
  let last = "";
  let funded = false;
  for (const until = Date.now() + waitMinutes * 60_000; Date.now() < until; ) {
    const [eth, zec] = await nearView<string[]>(INTENTS, "mt_batch_balance_of", {
      account_id: account,
      token_ids: [ETH_TOKEN_ID, DESTINATION],
    });
    let state = "";
    if (scan) {
      const r = await fetch(`${scan}/api/orders/${seq}`);
      state = r.ok ? ((await r.json()) as { state: string }).state : `scan ${r.status}`;
    }
    const line = `${state ? `scan ${state}, ` : ""}A: ${eth} wei ETH, ${zec} ZEC`;
    if (line !== last) console.log(`   +${new Date().toISOString().slice(11, 19)} ${(last = line)}`);
    // A held something and holds nothing now: delivered — or, in the refund test, refunded.
    const empty = BigInt(eth!) === 0n && BigInt(zec!) === 0n;
    if (funded && empty) return console.log(`\nDone: A is empty again. Check ${recipient} / ${signer}.`);
    funded ||= !empty;
    await new Promise((r) => setTimeout(r, 15_000));
  }
  console.log(`\nFollowed for ${waitMinutes} min. The router bot's /api/status shows what it did for ${authPath}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
