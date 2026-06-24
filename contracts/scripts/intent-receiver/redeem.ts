import "dotenv/config";

import { isAddress, isHex, parseEventLogs, formatEther, decodeAbiParameters } from "viem";

import { args } from "@whm/common";
import { ifs, wallet } from "@whm/common/evm";

import intentReceiverJson from "../../out/IntentReceiver.sol/IntentReceiver.json";

const { requiredArg, optionalArg, requiredEnv } = args;
const { getWallet } = wallet;

/** EXCLUSIVE_WINDOW in IntentReceiver — non-authorized callers must wait this long after the VAA's
 *  guardian timestamp before redemption goes public. Keep in sync with the contract constant. */
const EXCLUSIVE_WINDOW = 5 * 60;

/**
 * Normalize a VAA into a 0x-hex byte string for viem `bytes` args. Accepts the Wormhole API's default
 * base64 encoding, bare hex (no 0x), or already-0x hex.
 * @param raw the --vaa value as provided
 * @returns 0x-prefixed hex encoding of the VAA bytes
 */
function normalizeVaa(raw: string): `0x${string}` {
  if (isHex(raw)) return raw; // already 0x-hex
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) return `0x${raw}`; // bare hex
  return `0x${Buffer.from(raw, "base64").toString("hex")}`; // base64 (Wormhole API)
}

/** Minimal TokenBridge reads used by preflight. */
const tokenBridgeAbi = [
  {
    name: "wormhole",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    name: "isTransferCompleted",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "hash", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
  {
    name: "parseTransferWithPayload",
    type: "function",
    stateMutability: "pure",
    inputs: [{ name: "encoded", type: "bytes" }],
    outputs: [
      {
        name: "transfer",
        type: "tuple",
        components: [
          { name: "payloadID", type: "uint8" },
          { name: "amount", type: "uint256" },
          { name: "tokenAddress", type: "bytes32" },
          { name: "tokenChain", type: "uint16" },
          { name: "to", type: "bytes32" },
          { name: "toChain", type: "uint16" },
          { name: "fromAddress", type: "bytes32" },
          { name: "payload", type: "bytes" },
        ],
      },
    ],
  },
] as const;

/** Minimal IWormhole.parseVM (the fields preflight needs: timestamp, hash, payload). */
const wormholeAbi = [
  {
    name: "parseVM",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "encodedVM", type: "bytes" }],
    outputs: [
      {
        name: "vm",
        type: "tuple",
        components: [
          { name: "version", type: "uint8" },
          { name: "timestamp", type: "uint32" },
          { name: "nonce", type: "uint32" },
          { name: "emitterChainId", type: "uint16" },
          { name: "emitterAddress", type: "bytes32" },
          { name: "sequence", type: "uint64" },
          { name: "consistencyLevel", type: "uint8" },
          { name: "payload", type: "bytes" },
          { name: "guardianSetIndex", type: "uint32" },
          {
            name: "signatures",
            type: "tuple[]",
            components: [
              { name: "r", type: "bytes32" },
              { name: "s", type: "bytes32" },
              { name: "v", type: "uint8" },
              { name: "guardianIndex", type: "uint8" },
            ],
          },
          { name: "hash", type: "bytes32" },
        ],
      },
    ],
  },
] as const;

/**
 * Read-only preflight: resolves and prints every value `redeem` checks, so a revert is explained
 * before a tx is ever sent. Returns true when the redeem should succeed for this caller right now.
 *
 * @param publicClient viem public client bound to the target chain
 * @param receiver     IntentReceiver address
 * @param abi          IntentReceiver ABI
 * @param vaa          the payload-3 TokenBridge VAA
 * @param caller       the address that will call redeem (derived from --pk)
 * @param feeRequested relay fee the caller intends to claim
 * @returns whether redeem is expected to succeed for `caller` at the current block
 */
async function preflight(
  publicClient: ReturnType<typeof getWallet>["publicClient"],
  receiver: `0x${string}`,
  abi: ifs.ContractArtifact["abi"],
  vaa: `0x${string}`,
  caller: `0x${string}`,
  feeRequested: bigint,
): Promise<boolean> {
  const tokenBridge = (await publicClient.readContract({
    address: receiver,
    abi,
    functionName: "tokenBridge",
  })) as `0x${string}`;
  const wormhole = (await publicClient.readContract({
    address: tokenBridge,
    abi: tokenBridgeAbi,
    functionName: "wormhole",
  })) as `0x${string}`;

  const vm = (await publicClient.readContract({
    address: wormhole,
    abi: wormholeAbi,
    functionName: "parseVM",
    args: [vaa],
  })) as { timestamp: number; hash: `0x${string}`; payload: `0x${string}` };

  const [completed, count, isAuth, block] = await Promise.all([
    publicClient.readContract({
      address: tokenBridge,
      abi: tokenBridgeAbi,
      functionName: "isTransferCompleted",
      args: [vm.hash],
    }) as Promise<boolean>,
    publicClient.readContract({
      address: receiver,
      abi,
      functionName: "authorizedRelayerCount",
    }) as Promise<bigint>,
    publicClient.readContract({
      address: receiver,
      abi,
      functionName: "authorizedRelayer",
      args: [caller],
    }) as Promise<boolean>,
    publicClient.getBlock(),
  ]);

  const now = Number(block.timestamp);
  const opensAt = Number(vm.timestamp) + EXCLUSIVE_WINDOW;
  const remaining = opensAt - now;
  const windowActive = count > 0n && !isAuth && remaining > 0;

  // Decode the inner intent payload (intentId, depositAddress, maxRelayFee) for fee/destination checks.
  let maxRelayFee: bigint | undefined;
  let depositAddress: string | undefined;
  try {
    const transfer = (await publicClient.readContract({
      address: tokenBridge,
      abi: tokenBridgeAbi,
      functionName: "parseTransferWithPayload",
      args: [vm.payload],
    })) as { payload: `0x${string}` };
    [, depositAddress, maxRelayFee] = decodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
      transfer.payload,
    ) as [string, string, bigint];
  } catch {
    /* non-fatal — payload decode is informational */
  }

  console.log("── preflight ─────────────────────────────────");
  console.log("tokenBridge:       ", tokenBridge);
  console.log(
    "VAA timestamp:     ",
    vm.timestamp,
    `(${new Date(vm.timestamp * 1000).toISOString()})`,
  );
  console.log("block timestamp:   ", now, `(${new Date(now * 1000).toISOString()})`);
  console.log("already redeemed:  ", completed);
  console.log("authorizedCount:   ", count.toString());
  console.log("caller authorized: ", isAuth, `(${caller})`);
  console.log(
    "exclusive window:  ",
    windowActive ? `ACTIVE — opens to public in ${remaining}s` : "open (public)",
  );
  if (depositAddress) console.log("depositAddress:    ", depositAddress);
  if (maxRelayFee !== undefined) {
    console.log("maxRelayFee:       ", maxRelayFee.toString(), `(${formatEther(maxRelayFee)} ETH)`);
  }
  console.log("──────────────────────────────────────────────");

  if (completed) {
    console.error("✗ AlreadyRedeemed — this VAA is consumed; nothing to do.");
    return false;
  }
  if (windowActive) {
    console.error(
      `✗ Unauthorized — caller is not an authorized relayer and the exclusive window is still active.\n` +
        `  Wait ${remaining}s for public redemption, or call with the authorized relayer key.`,
    );
    return false;
  }
  if (maxRelayFee !== undefined && feeRequested > maxRelayFee) {
    console.error(
      `✗ FeeExceedsCeiling — feeRequested (${feeRequested}) > maxRelayFee (${maxRelayFee}).`,
    );
    return false;
  }
  return true;
}

/**
 * IntentReceiver.redeem — per-contract ops script for the Ethereum redeem leg.
 *
 * Takes a signed payload-3 TokenBridge VAA (`transferTokensWithPayload`) already addressed to the
 * IntentReceiver and runs the single on-chain step the live relayer (mrelayer/app-intent) performs:
 *
 *   redeem(vaa, feeRequested) → completeTransferWithPayload, unwrap WETH → native ETH, pay msg.sender
 *   feeRequested, forward the rest to the payload's OneClick depositAddress (emits IntentForwarded).
 *
 * Runs a read-only preflight first (VAA timestamp vs block timestamp, exclusive-window state, caller
 * authorization, already-redeemed, fee vs ceiling) and aborts with a precise verdict instead of
 * sending a doomed tx. Pass --force to send anyway.
 *
 * feeRequested defaults to 0 (forward everything, redeemer eats the gas). Pass --feeRequested to claim
 * a relay fee; it must be ≤ the maxRelayFee ceiling baked into the VAA payload or redeem reverts
 * FeeExceedsCeiling. For the full relayer emulation (quoter-priced fee + 1Click notify) see
 * scripts/nirRelay.ts.
 *
 * Env:  RPC, CHAIN_ID
 * Args: --pk --address(IntentReceiver) --vaa(0x… payload-3 VAA)  [--feeRequested(wei, default 0)] [--force]
 *
 * @returns resolves once the redeem tx is mined and the IntentForwarded event is logged
 */
async function main(): Promise<void> {
  const rpcUrl = requiredEnv("RPC");
  const chainId = Number(requiredEnv("CHAIN_ID"));

  const privateKey = requiredArg("--pk") as `0x${string}`;
  const address = requiredArg("--address"); // IntentReceiver proxy
  const vaa = normalizeVaa(requiredArg("--vaa")); // base64 (Wormhole API) / hex VAA → 0x bytes
  const feeRequested = BigInt(optionalArg("--feeRequested") ?? "0");
  const force = optionalArg("--force") !== undefined;

  if (!isAddress(address)) throw new Error("Invalid --address (IntentReceiver).");
  if (feeRequested < 0n) throw new Error("--feeRequested must be ≥ 0.");

  const { publicClient, walletClient, account } = getWallet(rpcUrl, chainId, privateKey);
  const { abi } = intentReceiverJson as ifs.ContractArtifact;

  console.log("IntentReceiver:", address);
  console.log("relayer:       ", account.address);
  console.log("feeRequested:  ", feeRequested.toString(), `(${formatEther(feeRequested)} ETH)`);

  const ok = await preflight(
    publicClient,
    address as `0x${string}`,
    abi,
    vaa,
    account.address,
    feeRequested,
  );
  if (!ok && !force) {
    process.exit(1);
  }
  if (!ok) console.warn("⚠ preflight failed but --force set — sending anyway.");

  // redeem(vaa, feeRequested) — pulls the released WETH, unwraps to ETH, pays the fee, forwards the
  // remainder. Atomic: it forwards (and emits IntentForwarded) or reverts; there is no queue.
  const hash = await walletClient.writeContract({
    address: address as `0x${string}`,
    abi,
    functionName: "redeem",
    args: [vaa, feeRequested],
    gas: 2_000_000n,
  });
  console.log("redeem tx:", hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log("status:", receipt.status, "block:", receipt.blockNumber);

  const forwarded = parseEventLogs({ abi, eventName: "IntentForwarded", logs: receipt.logs })[0];
  if (!forwarded) throw new Error("redeem succeeded but no IntentForwarded event — investigate.");
  const { intentId, asset, depositAddress, amount } = forwarded.args as {
    intentId: string;
    asset: string;
    depositAddress: string;
    amount: bigint;
  };
  console.log(
    `IntentForwarded intentId=${intentId} asset=${asset} → ${depositAddress} amount=${amount} (${formatEther(amount)} ETH)`,
  );

  const feePaid = parseEventLogs({ abi, eventName: "RelayFeePaid", logs: receipt.logs })[0];
  if (feePaid) {
    const { relayer, fee } = feePaid.args as { relayer: string; fee: bigint };
    console.log(`RelayFeePaid relayer=${relayer} fee=${fee} (${formatEther(fee)} ETH)`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
