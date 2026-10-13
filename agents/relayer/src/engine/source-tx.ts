import { setTimeout as sleep } from "timers/promises";

import logger from "../logger";
import type { ChainId, Next, RelayerCtx } from "../types";

import { loadVaa, normalizeTxHash } from "./vaa";

/**
 * Replaces the engine's own `sourceTx` middleware, which is disabled in `createApp`.
 *
 * That one sleeps `initialDelay * 2 ** retries` between attempts — `retries` being the retry
 * *limit*, a constant, not the attempt number — so with its mainnet defaults every wait is a flat
 * 32s. The spy hands us a VAA the moment the guardians sign it, which is reliably ahead of
 * Wormholescan's indexer, so the first lookup 404s and the pipeline stalls half a minute before it
 * ever reaches a handler. That sleep was most of the gap between an order being signed and this
 * relayer acting on it.
 */

/**
 * Waits between lookups, in ms.
 *
 * Nothing is tried inside the first two seconds because nothing there can succeed: measured against
 * an emitter that publishes at consistency level 200 — signed at once, so the delay is Wormholescan's
 * pipeline and nothing else — a message appears 2.2s after it exists at the very fastest, 3.0s
 * typically, 6.8s at the worst. Polling sooner spends calls on a miss that is certain.
 *
 * The flat tail is there because the alternative to giving up is worse: the handler treats a missing
 * hash as a retry, and the engine's smallest backoff is a minute.
 */
const RAMP_MS = [2_000, 2_000, 3_000, 5_000, 8_000, 8_000, 8_000];

/** Resolved hashes, so an engine retry of the same VAA does not poll again. Oldest evicted first. */
const CACHE_MAX = 1_000;
const cache = new Map<string, string>();

/**
 * Ask Wormholescan which transaction published a VAA.
 *
 * @param chain Wormhole chain id of the emitter.
 * @param emitter Emitter address, 32-byte hex without `0x`.
 * @param sequence The emitter's Wormhole sequence.
 * @returns The hash, or undefined while the message is indexed but carries none yet.
 */
async function lookup(
  chain: ChainId,
  emitter: string,
  sequence: bigint,
): Promise<string | undefined> {
  const { sourceTxHash } = await loadVaa(chain, emitter, sequence);
  return sourceTxHash ? normalizeTxHash(sourceTxHash) : undefined;
}

/**
 * Put the source transaction hash on the context.
 *
 * Costs one lookup per VAA, plus the ramp while the indexer catches up — a few seconds, against the
 * flat 32s the engine's own version spent. Worth it for an app that reads the source transaction,
 * and cheap enough for one that only logs the hash.
 *
 * @returns The middleware.
 */
export function sourceTx() {
  return async (ctx: RelayerCtx, next: Next): Promise<void> => {
    const { emitterChain, emitterAddress, sequence } = ctx.vaa;
    const emitter = emitterAddress.toString("hex");
    const id = `${emitterChain}/${emitter}/${sequence}`;

    const cached = cache.get(id);
    if (cached) {
      ctx.sourceTxHash = cached;
      return next();
    }

    // The first lookup is free of the ramp — a replayed VAA is old enough to already be indexed.
    for (let attempt = 0; ; attempt++) {
      try {
        const hash = await lookup(emitterChain, emitter, sequence);
        if (hash) {
          if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
          cache.set(id, hash);
          ctx.sourceTxHash = hash;
          return next();
        }
      } catch (e) {
        // A miss is the expected first answer, so it is only worth a line once the ramp is spent.
        if (attempt >= RAMP_MS.length) {
          logger.warn(`No source tx for ${id} after ${attempt + 1} attempts: ${e}`);
        }
      }
      if (attempt >= RAMP_MS.length) return next();
      await sleep(RAMP_MS[attempt], undefined, { ref: false });
    }
  };
}
