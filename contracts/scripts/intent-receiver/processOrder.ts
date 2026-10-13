import "dotenv/config";

import { isAddress, isHex, parseEventLogs, formatEther, decodeAbiParameters, pad } from "viem";

import { args } from "@whm/common";
import { ifs, wallet } from "@whm/common/evm";

import intentReceiverJson from "../../out/IntentReceiver.sol/IntentReceiver.json";

const { requiredArg, optionalArg, requiredEnv, optionalEnv } = args;
const { getWallet } = wallet;

/** Hydration's Wormhole chain id — the only emitter chain the receiver accepts. */
const HYDRATION_CHAIN = 73;

/**
 * TransceiverMessage wire format, as far as the NTT manager's message id:
 *   prefix(4) sourceManager(32) recipientManager(32) payloadLen(2) id(32) …
 * `id` is bytes32(uint256(sequence)), so the uint64 sits in its last 8 bytes. Mirrors
 * NttPayload.sequenceOf, which is what the contract checks against.
 */
const SEQUENCE_OFFSET = 70 + 24;
const DECIMALS_OFFSET = 140;
const AMOUNT_OFFSET = 141;

/**
 * Normalize a VAA into a 0x-hex byte string for viem `bytes` args. Accepts the Wormhole API's
 * default base64 encoding, bare hex (no 0x), or already-0x hex.
 *
 * @param raw the --nttVaa / --instructionVaa value as provided
 * @returns 0x-prefixed hex encoding of the VAA bytes
 */
function normalizeVaa(raw: string): `0x${string}` {
  if (isHex(raw)) return raw;
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) return `0x${raw}`;
  return `0x${Buffer.from(raw, "base64").toString("hex")}`;
}

/**
 * Read the NTT manager's sequence out of a settlement payload.
 *
 * @param payload the transceiver payload, 0x-hex
 * @returns the manager's message sequence
 */
function settlementSequence(payload: `0x${string}`): bigint {
  return Buffer.from(payload.slice(2), "hex").readBigUInt64BE(SEQUENCE_OFFSET);
}

/**
 * Read what a settlement releases, scaled out of NTT's trimmed representation.
 *
 * @param payload the transceiver payload, 0x-hex
 * @param decimals precision the destination expects, 18 for native ETH
 * @returns the amount in the destination's own units
 */
function settlementAmount(payload: `0x${string}`, decimals: number): bigint {
  const bytes = Buffer.from(payload.slice(2), "hex");
  const trimmedTo = bytes.readUInt8(DECIMALS_OFFSET);
  return bytes.readBigUInt64BE(AMOUNT_OFFSET) * 10n ** BigInt(decimals - trimmedTo);
}

/** IWormhole reads the preflight needs. */
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

/** WormholeTransceiver read that tells us whether the settlement has already been delivered. */
const transceiverAbi = [
  {
    name: "isVAAConsumed",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "hash", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
] as const;

/**
 * Read-only preflight: resolves and prints every value `processOrder` checks, so a revert is
 * explained before a tx is ever sent.
 *
 * @param publicClient   viem public client bound to Ethereum
 * @param receiver       IntentReceiver address
 * @param abi            IntentReceiver ABI
 * @param nttVaa         the NTT settlement VAA
 * @param instructionVaa the emitter's forwarding instruction for the same sequence
 * @param feeRequested   relay fee the caller intends to claim
 * @returns whether processOrder is expected to succeed at the current block
 */
async function preflight(
  publicClient: ReturnType<typeof getWallet>["publicClient"],
  receiver: `0x${string}`,
  abi: ifs.ContractArtifact["abi"],
  nttVaa: `0x${string}`,
  instructionVaa: `0x${string}`,
  feeRequested: bigint,
): Promise<boolean> {
  const [wormhole, transceiver, pinnedEmitter] = (await Promise.all([
    publicClient.readContract({ address: receiver, abi, functionName: "wormhole" }),
    publicClient.readContract({ address: receiver, abi, functionName: "transceiver" }),
    publicClient.readContract({ address: receiver, abi, functionName: "emitterAddress" }),
  ])) as [`0x${string}`, `0x${string}`, `0x${string}`];

  const [settlement, instruction] = (await Promise.all([
    publicClient.readContract({
      address: wormhole,
      abi: wormholeAbi,
      functionName: "parseVM",
      args: [nttVaa],
    }),
    publicClient.readContract({
      address: wormhole,
      abi: wormholeAbi,
      functionName: "parseVM",
      args: [instructionVaa],
    }),
  ])) as [
    { hash: `0x${string}`; payload: `0x${string}` },
    {
      hash: `0x${string}`;
      payload: `0x${string}`;
      emitterChainId: number;
      emitterAddress: `0x${string}`;
    },
  ];

  const [sequence, depositAddress, maxRelayFee] = decodeAbiParameters(
    [{ type: "uint64" }, { type: "address" }, { type: "uint256" }],
    instruction.payload,
  ) as [bigint, `0x${string}`, bigint];

  const settled = settlementSequence(settlement.payload);

  const [alreadyUsed, delivered, balance] = await Promise.all([
    publicClient.readContract({
      address: receiver,
      abi,
      functionName: "processed",
      args: [instruction.hash],
    }) as Promise<boolean>,
    publicClient.readContract({
      address: transceiver,
      abi: transceiverAbi,
      functionName: "isVAAConsumed",
      args: [settlement.hash],
    }) as Promise<boolean>,
    publicClient.getBalance({ address: receiver }),
  ]);

  const amount = settlementAmount(settlement.payload, 18);

  console.log("── preflight ─────────────────────────────────");
  console.log("wormhole:          ", wormhole);
  console.log("transceiver:       ", transceiver);
  console.log("pinned emitter:    ", pinnedEmitter);
  console.log(
    "instruction emitter:",
    instruction.emitterAddress,
    `chain ${instruction.emitterChainId}`,
  );
  console.log("instruction seq:   ", sequence.toString());
  console.log("settlement seq:    ", settled.toString());
  console.log("depositAddress:    ", depositAddress);
  console.log("amount:            ", amount.toString(), `(${formatEther(amount)} ETH)`);
  console.log("maxRelayFee:       ", maxRelayFee.toString(), `(${formatEther(maxRelayFee)} ETH)`);
  console.log("instruction used:  ", alreadyUsed);
  console.log("settlement delivered:", delivered);
  console.log("receiver balance:  ", balance.toString(), `(${formatEther(balance)} ETH)`);
  console.log("──────────────────────────────────────────────");

  if (
    instruction.emitterChainId !== HYDRATION_CHAIN ||
    instruction.emitterAddress !== pinnedEmitter
  ) {
    console.error(
      `✗ UnauthorizedEmitter — instruction is from ${instruction.emitterChainId}/${instruction.emitterAddress}, ` +
        `receiver pins ${HYDRATION_CHAIN}/${pinnedEmitter}.`,
    );
    return false;
  }
  if (alreadyUsed) {
    console.error("✗ AlreadyRedeemed — this instruction has been acted on; nothing to do.");
    return false;
  }
  if (sequence !== settled) {
    console.error(
      `✗ SequenceMismatch — instruction names ${sequence}, settlement carries ${settled}.`,
    );
    return false;
  }
  if (feeRequested > maxRelayFee) {
    console.error(
      `✗ FeeExceedsCeiling — feeRequested (${feeRequested}) > maxRelayFee (${maxRelayFee}).`,
    );
    return false;
  }
  // The forward is sized by the settlement, so a shortfall shows up as the native transfer failing
  // rather than as a named revert. Worth flagging when the settlement has already landed.
  if (delivered && balance < settlementAmount(settlement.payload, 18)) {
    console.error(
      `✗ receiver holds ${balance}, settlement released ` +
        `${settlementAmount(settlement.payload, 18)} — the forward will revert.`,
    );
    return false;
  }
  if (!delivered) {
    console.log("ℹ settlement not yet delivered — this call will deliver it before forwarding.");
  }
  return true;
}

/**
 * IntentReceiver.processOrder — per-contract ops script for the Ethereum leg of intents v2.
 *
 * Takes the NTT settlement VAA and the emitter's forwarding instruction for the same manager
 * sequence, and runs the single on-chain step the live relayer (relayer, intent feature) performs:
 *
 *   processOrder(nttVaa, instructionVaa, feeRequested) → deliver the settlement through the
 *   transceiver (skipped if someone already did), pay msg.sender feeRequested, forward the rest to
 *   the instruction's depositAddress (emits OrderProcessed).
 *
 * Forwarded, not completed — NEAR still swaps into the order's destinationAsset and delivers to its
 * recipient.
 *
 * Runs a read-only preflight first and aborts with a precise verdict instead of sending a doomed tx.
 * Pass --force to send anyway.
 *
 * Env:  RPC, CHAIN_ID, RPC_SUBMIT? (private broadcast endpoint — reads still go to RPC)
 * Args: --pk --address(IntentReceiver) --nttVaa --instructionVaa [--feeRequested(wei, default 0)] [--force]
 *
 * @returns resolves once the tx is mined and OrderProcessed is logged
 */
async function main(): Promise<void> {
  const rpcUrl = requiredEnv("RPC");
  const chainId = Number(requiredEnv("CHAIN_ID"));

  const privateKey = requiredArg("--pk") as `0x${string}`;
  const address = requiredArg("--address"); // IntentReceiver proxy
  const nttVaa = normalizeVaa(requiredArg("--nttVaa"));
  const instructionVaa = normalizeVaa(requiredArg("--instructionVaa"));
  const feeRequested = BigInt(optionalArg("--feeRequested") ?? "0");
  const force = optionalArg("--force") !== undefined;

  if (!isAddress(address)) throw new Error("Invalid --address (IntentReceiver).");
  if (feeRequested < 0n) throw new Error("--feeRequested must be ≥ 0.");

  const { publicClient, walletClient, account } = getWallet(rpcUrl, chainId, privateKey);
  const { abi } = intentReceiverJson as ifs.ContractArtifact;

  // Recovering an order whose exclusive window has lapsed means broadcasting a call anyone can
  // profitably copy, fee and all. RPC_SUBMIT sends it somewhere private instead; reads stay on RPC.
  const submitRpc = optionalEnv("RPC");
  const submitter = submitRpc
    ? getWallet(submitRpc, chainId, privateKey).walletClient
    : walletClient;

  console.log("IntentReceiver:", address);
  console.log("relayer:       ", account.address);
  console.log("feeRequested:  ", feeRequested.toString(), `(${formatEther(feeRequested)} ETH)`);
  console.log("submit via:    ", submitRpc ?? rpcUrl);

  const ok = await preflight(
    publicClient,
    address as `0x${string}`,
    abi,
    nttVaa,
    instructionVaa,
    feeRequested,
  );
  if (!ok && !force) {
    process.exit(1);
  }
  if (!ok) console.warn("⚠ preflight failed but --force set — sending anyway.");

  // Estimated, not guessed: a private endpoint may not serve eth_estimateGas, and the limit has to
  // be the real one either way.
  const gas = await publicClient.estimateContractGas({
    address: address as `0x${string}`,
    abi,
    functionName: "processOrder",
    args: [nttVaa, instructionVaa, feeRequested],
    account,
  });
  console.log("gas:           ", gas.toString());

  const hash = await submitter.writeContract({
    address: address as `0x${string}`,
    abi,
    functionName: "processOrder",
    args: [nttVaa, instructionVaa, feeRequested],
    gas,
  });
  console.log("processOrder tx:", hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(
    "status:",
    receipt.status,
    "block:",
    receipt.blockNumber,
    "gasUsed:",
    receipt.gasUsed,
  );
  if (receipt.status === "reverted") {
    throw new Error(`processOrder reverted in ${hash} — nothing was delivered.`);
  }

  const forwarded = parseEventLogs({ abi, eventName: "OrderProcessed", logs: receipt.logs })[0];
  if (!forwarded)
    throw new Error("processOrder succeeded but no OrderProcessed event — investigate.");
  const { transferSequence, depositAddress, amount } = forwarded.args as {
    transferSequence: bigint;
    depositAddress: string;
    amount: bigint;
  };
  console.log(
    `OrderProcessed seq=${transferSequence} → ${depositAddress} amount=${amount} (${formatEther(amount)} ETH)`,
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
