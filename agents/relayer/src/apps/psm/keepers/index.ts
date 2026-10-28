import type { Address, Chain, PublicClient, Transport } from "viem";

import { WORMHOLE } from "../../../chains";
import type { ChainClients } from "../../../engine/hydration";
import { every } from "../../../engine/loop";
import type { Alerter } from "../../../engine/notify";
import type { Queue } from "../../../engine/queue";
import logger from "../../../logger";
import type { ChainId } from "../../../types";

import { facilitatorKeeperAbi } from "../abi";
import { FLUSH_FROM_ID, KEEPER_ENABLED, KEEPER_INTERVAL_MS } from "../config";
import type { PsmRoute } from "../routes";
import type { KeeperCtx } from "./common";
import { drainTick, type DrainState } from "./drain";
import { flushState, flushTick, type FlushState, type FlushTarget } from "./flush";
import { baseWatch, baseWatchTick, hydrationWatch, hydrationWatchTick } from "./watch";

/** Consecutive failed ticks before a loop reports itself. */
const LOOP_FAILURES_ALERT = 5;

/**
 * Run `tick` every `ms`, alerting once it has failed `LOOP_FAILURES_ALERT` ticks in a row. A tick
 * that succeeds clears the alert, so the next run of failures is reported again.
 *
 * @param failing What is failing, as the alert's state: a change posts at once rather than at the
 *        hourly repeat, so a watcher whose second check breaks while the first is down says so.
 * @returns A function that stops the loop after the current tick.
 */
export function keeperLoop(
  app: string,
  alerter: Alerter,
  label: string,
  ms: number,
  tick: () => Promise<void>,
  failing: () => string = () => "failing",
): () => void {
  const key = `psm:loop:${label}`;
  return every(
    `${app} ${label}`,
    ms,
    async () => {
      await tick();
      alerter.clear(key);
    },
    (n, e) => {
      if (n >= LOOP_FAILURES_ALERT) {
        alerter.alert(key, failing(), `${app}: ${label} has failed ${n} ticks in a row: ${(e as Error)?.message ?? String(e)}`);
      }
    },
  );
}

export interface KeeperDeps {
  app: string;
  clients: ChainClients;
  queue: Queue;
  alerter: Alerter;
  routes: PsmRoute[];
  /** psm-base's keyless Hydration reader, for the books check; without one the check is off. */
  books?: PublicClient<Transport, Chain>;
}

/**
 * Start the keepers and watchers for the process's destination chain, without waiting on them.
 *
 * Each runs in its own loop on the process's one wallet and queue. `psm-base` drains the vault and
 * watches it, reading the facilitator's side of the books keylessly; `psm-hydration` flushes queued
 * mints and watches the facilitator. Contracts come from the served route: its destination is this
 * chain's PSM contract, its source the other chain's.
 */
export function startKeepers(destinationChain: ChainId, deps: KeeperDeps): void {
  const ctx: KeeperCtx = {
    clients: deps.clients,
    queue: deps.queue,
    alerter: deps.alerter,
    enabled: KEEPER_ENABLED,
    log: logger,
    now: Date.now,
  };
  const route = deps.routes[0];
  if (!route) return;

  const loop = (label: string, tick: () => Promise<void>, failing?: () => string) =>
    keeperLoop(deps.app, deps.alerter, label, KEEPER_INTERVAL_MS, tick, failing);

  logger.info(`  keepers: ${KEEPER_ENABLED ? "sending" : "OFF (PSM_KEEPER=off); watchers only"}`);

  if (destinationChain === WORMHOLE.base) {
    const vault = route.destinationContract;
    const drain: DrainState = {};
    loop("drain", async () => {
      const outcome = await drainTick(ctx, vault, drain);
      if (outcome.kind === "sent") logger.info(`psm drain: sent ${outcome.hash ?? "nothing"}`);
    });

    const reader = deps.books;
    const watch = baseWatch(vault, reader ? { facilitator: route.sourceEmitter, reader: async () => reader } : undefined);
    loop("vault watch", () => baseWatchTick(ctx, watch), () => watch.failed.join(",") || "failing");
    return;
  }

  if (destinationChain === WORMHOLE.hydration) {
    const facilitator = route.destinationContract;
    let target: FlushTarget | undefined;
    let state: FlushState | undefined;
    loop("flush", async () => {
      if (!target) {
        const read = <T>(functionName: string): Promise<T> =>
          ctx.clients.publicClient.readContract({ address: facilitator, abi: facilitatorKeeperAbi, functionName } as never) as never;
        target = { facilitator, hollar: await read<Address>("hollar"), scale: await read<bigint>("scale"), fromId: FLUSH_FROM_ID };
        state = flushState(target);
      }
      const outcome = await flushTick(ctx, target, state!);
      if (outcome.kind === "scanned" && outcome.flushed.length > 0) {
        logger.info(`psm flush: flushed ${outcome.flushed.join(", ")}`);
      }
    });

    const watch = hydrationWatch(facilitator);
    loop("facilitator watch", () => hydrationWatchTick(ctx, watch), () => watch.failed.join(",") || "failing");
  }
}
