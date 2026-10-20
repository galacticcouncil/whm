import { keccak256, parseAbiItem, toHex, toEventSelector, type AbiEvent } from "viem";

import type { NearEvent } from "./types";

/**
 * Wormhole and NTT event shapes. Infrastructure, not a feature — every corridor in this repo
 * publishes through the same core and settles through the same manager.
 */

/** Wormhole core. The `sender` topic is what narrows the core down to emitters we own. */
export const LogMessagePublishedEvt = parseAbiItem(
  "event LogMessagePublished(address indexed sender, uint64 sequence, uint32 nonce, bytes payload, uint8 consistencyLevel)",
);

/**
 * NTT Wormhole transceiver, destination side — the VAA was verified and consumed.
 *
 * Its first field is named `digest` but holds the VAA hash, which is not the digest the manager's
 * delivery events carry. Kept faithful to the deployed ABI regardless; renaming it here would only
 * make the log disagree with the chain.
 */
export const ReceivedMessageEvt = parseAbiItem(
  "event ReceivedMessage(bytes32 digest, uint16 emitterChainId, bytes32 emitterAddress, uint64 sequence)",
);

/** NTT manager, destination side — the transfer released to its recipient. */
export const TransferRedeemedEvt = parseAbiItem("event TransferRedeemed(bytes32 indexed digest)");

/**
 * NTT manager, destination side — the inbound rate limiter is holding the transfer. Delivered but
 * crediting nothing, which is the state a stuck corridor sits in.
 */
export const InboundTransferQueuedEvt = parseAbiItem(
  "event InboundTransferQueued(bytes32 digest)",
);

/**
 * A NEAR event's stand-in for `topic0`, so it is stored, routed and replayed exactly like a log:
 * `keccak256("<standard>:<event>")`.
 *
 * @param e The event's identity.
 */
export function nearTopic(e: NearEvent): `0x${string}` {
  return keccak256(toHex(`${e.standard}:${e.event}`));
}

/**
 * The `topic0` a leg's events are stored under, whichever chain they come from.
 *
 * @param leg Exactly one of an EVM event or a NEAR event.
 */
export function legTopic(leg: { abi?: AbiEvent; near?: NearEvent }): `0x${string}` {
  if (leg.abi) return toEventSelector(leg.abi);
  if (leg.near) return nearTopic(leg.near);
  throw new Error("a leg names neither an abi nor a near event");
}
