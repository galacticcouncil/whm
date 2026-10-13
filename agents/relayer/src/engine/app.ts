import {
  Environment,
  StandardRelayerApp,
  type StandardRelayerContext,
} from "@wormhole-foundation/relayer-engine";

import logger from "../logger";
import type { EngineConfig } from "../config";
import type { ChainId, RelayerApp } from "../types";

import { sourceTx } from "./source-tx";

export interface AppOptions {
  /**
   * Engine namespace. LOAD-BEARING: every Redis key derives from it —
   *   queue          {name}:{name}-relays
   *   seen VAAs      {name}:missedVaasV3:seenVaas:{chain}:{emitter}
   *   safe sequence  {name}:missedVaasV3:safeSequence:{chain}:{emitter}
   * Changing it orphans the existing state, and the missed-VAA worker then rescans from
   * `startingSequence` — replaying a backlog or silently skipping. Never rename to tidy up.
   */
  name: string;
  /** Cold-start floor per chain. Ignored once a safeSequence exists in Redis. */
  startingSequence?: Record<ChainId, bigint>;
  /** Total attempts per VAA before the engine gives up. */
  retries?: number;
  /** Backoff between attempts: min(2^attempt * base, max). */
  backoff?: { baseMs: number; maxMs: number };
  /**
   * Resolve `ctx.sourceTxHash` before handlers run, holding the VAA until Wormholescan has indexed
   * it. Only for an app that reads the source transaction — it trades latency for the hash, and an
   * app that just logs it should leave this off and relay the moment the spy delivers.
   */
  sourceTx?: boolean;
}

/**
 * Build the relayer app for one role.
 *
 * @param cfg Spy endpoint + Redis, shared by every role.
 * @param opts Namespace and retry policy for this role.
 * @returns The app, not yet listening.
 */
export function createApp(cfg: EngineConfig, opts: AppOptions): RelayerApp {
  // Namespace and floors decide what the missed-VAA worker rescans, and both are silent when wrong.
  logger.info(
    `  namespace:   ${opts.name}  floors ${JSON.stringify(opts.startingSequence ?? {}, (_, v) =>
      typeof v === "bigint" ? v.toString() : v,
    )}`,
  );


  const app = new StandardRelayerApp<StandardRelayerContext>(Environment.MAINNET, {
    name: opts.name,
    logger,
    spyEndpoint: cfg.spyEndpoint,
    redis: cfg.redis,
    // Ours instead — see engine/source-tx.ts. The engine's sleeps a flat 32s on the miss that
    // every fresh VAA produces, because the spy is ahead of the Wormholescan indexer it asks.
    fetchSourceTxhash: false,
    ...(opts.retries ? { workflows: { retries: opts.retries } } : {}),
    ...(opts.backoff
      ? {
          retryBackoffOptions: { baseDelayMs: opts.backoff.baseMs, maxDelayMs: opts.backoff.maxMs },
        }
      : {}),
    ...(opts.startingSequence
      ? { missedVaaOptions: { startingSequenceConfig: opts.startingSequence } }
      : {}),
  });

  // Registered here so it runs ahead of the chain routes, which `listen()` appends last.
  if (opts.sourceTx) app.use(sourceTx() as never);

  return app;
}

