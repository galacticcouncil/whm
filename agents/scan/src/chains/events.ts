import type { NearEvent } from "../types";

/**
 * The events the Solana and Sui watchers store.
 *
 * Neither chain's NTT logs anything of its own, so a watcher decodes what the transaction did — the
 * instructions on Solana, the calls and their inputs on Sui — into these, and stores them as NEAR's
 * are: JSON, under `keccak256("<standard>:<event>")`. A leg reads them through `near`, which names an
 * event of that shape whichever chain wrote it.
 */

/**
 * A Wormhole publish, in NEAR's core's own shape, so the one leg that reads NEAR's reads all three.
 * Stored with the emitter as its second topic, so a watch entry's topic filter keeps only ours.
 */
export const PUBLISH: NearEvent = { standard: "wormhole", event: "publish" };

export interface Publish {
  /** The payload, hex without `0x`. */
  data: string;
  nonce: number;
  /** The emitter as the VAA names it — 32 bytes, hex without `0x`. */
  emitter: string;
  /** A u64, so a string. */
  seq: string;
  consistency: number;
}

/** A VAA verified by an NTT manager: attested, not yet released. */
export const NTT_RECEIVED: NearEvent = { standard: "ntt", event: "received" };

export interface NttReceived {
  digest: `0x${string}`;
  vaaId: string;
  /**
   * Solana only: the inbox item the release will name — a PDA of the digest, and the only handle a
   * release has on the transfer, since it carries no VAA.
   */
  inboxItem?: string;
}

/** Released to the recipient. */
export const NTT_RELEASED: NearEvent = { standard: "ntt", event: "released" };

/** Held back by the inbound rate limit; a later release frees it. */
export const NTT_QUEUED: NearEvent = { standard: "ntt", event: "queued" };

/** A release or a hold: by its digest where the transaction names it, else by its inbox item. */
export interface NttSettled {
  digest?: `0x${string}`;
  inboxItem?: string;
}

/**
 * Whether stored topics pass a watch entry's positional filter — what `eth_getLogs` does with it,
 * for chains whose events are not EVM logs.
 *
 * @param topics The event's topics.
 * @param filter The watch entry's `topics`, if any.
 */
export function topicsMatch(
  topics: readonly string[],
  filter?: (string | string[] | null)[],
): boolean {
  return (filter ?? []).every((want, i) => {
    if (want === null) return true;
    const have = topics[i]?.toLowerCase();
    return Array.isArray(want)
      ? want.some((w) => w.toLowerCase() === have)
      : want.toLowerCase() === have;
  });
}
