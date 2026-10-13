import {
  decodeAbiParameters,
  decodeEventLog,
  pad,
  toEventSelector,
  type Address,
  type Hash,
  type PublicClient,
} from "viem";

import { coreBridgeAbi, instructionAbi } from "./abi";

const LOG_MESSAGE_PUBLISHED = toEventSelector(coreBridgeAbi[0]);

export interface Instruction {
  /** The emitter's Wormhole sequence — how the signed instruction VAA is addressed. */
  messageSequence: bigint;
  depositAddress: Address;
  maxRelayFee: bigint;
}

/**
 * Find the forwarding instruction the emitter published alongside a settlement.
 *
 * Both messages ride the same Hydration transaction, so the core bridge logged them into one
 * receipt. Matching on the manager sequence rather than taking the first log keeps a transaction
 * that ever carries more than one order honest.
 *
 * @param client Hydration public client.
 * @param emitter IntentEmitter address, whose logs we are looking for.
 * @param txHash Hydration transaction that produced the settlement.
 * @param sequence Manager sequence read from the settlement.
 * @returns The instruction, or null when this transaction published none — i.e. the settlement
 *          belongs to some other WETH transfer rather than an intent order.
 */
export async function findInstruction(
  client: PublicClient,
  emitter: Address,
  txHash: Hash,
  sequence: bigint,
): Promise<Instruction | null> {
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  const emitterTopic = pad(emitter, { size: 32 }).toLowerCase();

  for (const log of receipt.logs) {
    if (log.topics[0] !== LOG_MESSAGE_PUBLISHED) continue;
    if ((log.topics[1] ?? "").toLowerCase() !== emitterTopic) continue;

    const { args } = decodeEventLog({
      abi: coreBridgeAbi,
      eventName: "LogMessagePublished",
      topics: log.topics,
      data: log.data,
    });

    const [instructed, depositAddress, maxRelayFee] = decodeAbiParameters(
      instructionAbi,
      args.payload,
    );
    if (instructed !== sequence) continue;

    return { messageSequence: args.sequence, depositAddress, maxRelayFee };
  }

  return null;
}
