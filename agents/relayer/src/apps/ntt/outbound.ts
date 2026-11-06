import { concat, keccak256, parseAbi, toHex, type Hash, type Hex } from "viem";

import type { ChainClients } from "../../clients/hydration";
import { receiveMessage } from "../../clients/hydration";
import { isForManager, isNttTransfer } from "../../engine/ntt";
import type { Queue } from "../../engine/queue";
import type logger from "../../logger";
import type { ParsedVaa } from "../../types";

import type { OutboundNttRoute } from "./routes";

export const outboundAbi = parseAbi([
  "function receiveMessage(bytes encodedMessage) external",
  "function isVAAConsumed(bytes32 hash) external view returns (bool)",
  "function isMessageExecuted(bytes32 digest) external view returns (bool)",
  "error TransferAlreadyCompleted(bytes32 vaaHash)",
]);

/**
 * Offsets into the transceiver payload past those `engine/ntt.ts` documents: the manager message
 * runs from byte 70 for the length at byte 68, and the transfer's `toChain` sits after
 * prefix (4) · decimals (1) · amount (8) · sourceToken (32) · to (32), counted from byte 136.
 */
const MANAGER_MESSAGE_LENGTH_OFFSET = 68;
const MANAGER_MESSAGE_OFFSET = 70;
const TO_CHAIN_OFFSET = 136 + 4 + 1 + 8 + 32 + 32;

/** Each guardian signature is index (1) · r (32) · s (32) · v (1). */
const SIGNATURE_LENGTH = 66;

/**
 * The hash the transceiver marks consumed: Wormhole's `vm.hash`, keccak256 of keccak256 of the VAA
 * body (everything after the signatures).
 *
 * @param vaaBytes The guardian-signed VAA.
 */
export function vaaHash(vaaBytes: Buffer): Hash {
  const signatures = vaaBytes.readUInt8(5);
  const body = vaaBytes.subarray(6 + signatures * SIGNATURE_LENGTH);
  return keccak256(keccak256(toHex(body)));
}

/**
 * The digest the destination manager marks executed: keccak256(uint16 source chain ‖ the encoded
 * manager message), as `TransceiverStructs.nttManagerMessageDigest` computes it. It is the same for
 * every signed copy of one transfer, where the VAA hash is not.
 *
 * @param sourceChain Wormhole chain id the transfer left from.
 * @param payload Raw transceiver payload bytes.
 */
export function managerDigest(sourceChain: number, payload: Buffer): Hash {
  const length = payload.readUInt16BE(MANAGER_MESSAGE_LENGTH_OFFSET);
  const message = payload.subarray(MANAGER_MESSAGE_OFFSET, MANAGER_MESSAGE_OFFSET + length);
  return keccak256(concat([toHex(sourceChain, { size: 2 }), toHex(message) as Hex]));
}

/**
 * The Wormhole chain a transfer is addressed to.
 *
 * @param payload Raw transceiver payload bytes of a transfer.
 */
export function targetChain(payload: Buffer): number {
  return payload.readUInt16BE(TO_CHAIN_OFFSET);
}

/**
 * What one pass over a VAA did. `delivered` and `already-delivered` are the two outcomes that end
 * the job; `completed-elsewhere` means the pre-check read "not delivered" and the submission then
 * found it delivered (someone else's transaction landed in between).
 */
export type Outcome = "ignored" | "already-delivered" | "delivered" | "completed-elsewhere";

/**
 * Deliver one Hydration -> Base NTT transfer, once.
 *
 * Reads both replay guards first — the transceiver's `isVAAConsumed(vaa hash)` and the manager's
 * `isMessageExecuted(digest)`; the second also covers a second signed copy of the same transfer,
 * which carries another VAA hash and which the manager would accept and silently skip, spending
 * gas. Then the queue submits, and `submit` simulates before it spends a nonce.
 *
 * Never a blind retry: a throw here hands the job back to the engine, and the retry starts again
 * from the two reads, so a transaction that landed after all reads as delivered. The receipt is
 * read for this delivery's own hash; a replacement or an on-chain revert throws for the same
 * reason. The worst case is a second transaction after an unobserved first one that lands late:
 * the transceiver then reverts it on the consumed VAA, so it costs gas and never pays twice.
 *
 * @param route The outbound route the VAA arrived on.
 * @param vaa The parsed VAA.
 * @param clients Base account and clients.
 * @param queue This process's submission queue.
 * @param log Logger for this VAA.
 * @returns What the pass did.
 * @throws On anything unproven, for the engine to retry.
 */
export async function deliverOutbound(
  route: OutboundNttRoute,
  vaa: ParsedVaa,
  clients: ChainClients,
  queue: Queue,
  log: typeof logger,
): Promise<Outcome> {
  if (!isNttTransfer(vaa.payload)) {
    log.info("Ignoring non-transfer NTT transceiver message");
    return "ignored";
  }
  if (!isForManager(vaa.payload, route.manager) || targetChain(vaa.payload) !== route.destinationChain) {
    log.info("Ignoring NTT transfer for another destination");
    return "ignored";
  }

  const { publicClient } = clients;
  const [consumed, executed] = await Promise.all([
    publicClient.readContract({
      address: route.transceiver,
      abi: outboundAbi,
      functionName: "isVAAConsumed",
      args: [vaaHash(vaa.bytes)],
    }),
    publicClient.readContract({
      address: route.manager,
      abi: outboundAbi,
      functionName: "isMessageExecuted",
      args: [managerDigest(vaa.emitterChain, vaa.payload)],
    }),
  ]);
  if (consumed || executed) {
    log.info(`${route.token} transfer already delivered on Base (vaa consumed ${consumed}, message executed ${executed})`);
    return "already-delivered";
  }

  const sent: { hash?: Hash } = {};
  await queue.add({
    label: `${route.token} transfer to Base`,
    logger: log,
    submit: async (n) =>
      (sent.hash = await receiveMessage(clients, outboundAbi, route.transceiver, vaa.bytes, n)),
  });
  if (!sent.hash) return "completed-elsewhere";

  const receipt = await publicClient.waitForTransactionReceipt({ hash: sent.hash });
  if (receipt.transactionHash.toLowerCase() !== sent.hash.toLowerCase()) {
    throw new Error(`ntt-base ${route.token}: delivery ${sent.hash} was replaced by ${receipt.transactionHash}`);
  }
  if (receipt.status !== "success") {
    throw new Error(`ntt-base ${route.token}: delivery ${sent.hash} reverted on chain`);
  }
  return "delivered";
}
