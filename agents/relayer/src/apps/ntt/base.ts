import { boot } from "../../boot";
import { BASE_EVM_CHAIN_ID, WORMHOLE } from "../../chains";
import { alerts, engineConfig, privateKeyBase } from "../../config";
import { baseClients } from "../../clients/base";
import { createApp } from "../../engine/app";
import { onEmitter } from "../../engine/emitter";
import { createQueue } from "../../engine/queue";
import logger from "../../logger";
import type { Next, RelayerCtx } from "../../types";

import {
  APP_NAME_BASE,
  fromSequenceFromHydration,
  graceSeconds,
  RETRIES_BASE,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  RPC_BASE,
} from "./config";
import { discordAlert, runOutbound, type SentLedger } from "./outbound";
import { BASE_ROUTES } from "./routes";

/**
 * Delivers NTT transfers **from Hydration to Base** as a backstop: each transfer VAA from a
 * `BASE_ROUTES` Hydration transceiver that nobody has delivered `graceSeconds()` after it was signed
 * is submitted to that route's Base transceiver, which pays the recipient named in the signed
 * message. The user's own claim or the Wormhole Executor normally delivers first; this covers the
 * transfers nobody claims, such as one to an address that cannot send a transaction itself.
 *
 * Its own process and its own Base wallet, the same split as `psm-base`: signs with
 * `PRIVKEY_BASE`, never `PRIVKEY`, and its value must differ from `app-psm-base`'s, or the two
 * queues share one nonce. A Base wallet running low warns (and alerts the Discord webhook when set);
 * one that cannot pay for a delivery exits this process only, as every queue does.
 */
async function start(): Promise<void> {
  const startingSequence = fromSequenceFromHydration();
  const grace = graceSeconds();
  const key = privateKeyBase();
  const clients = await baseClients(RPC_BASE, key);
  const { account, publicClient } = clients;

  // Same refusal as psm's `assertDestination`: a route to an address with no code would mine,
  // spend gas and deliver nothing.
  for (const route of BASE_ROUTES) {
    if (route.destinationChain !== WORMHOLE.base) {
      throw new Error(`ntt-base route ${route.token} is not addressed to Base`);
    }
    for (const address of [route.manager, route.transceiver]) {
      const code = await publicClient.getCode({ address });
      if (!code || code === "0x") {
        throw new Error(`ntt-base route ${route.token}: ${address} has no code on Base (${BASE_EVM_CHAIN_ID})`);
      }
    }
  }

  const queue = createQueue({ publicClient, account, ...alerts() });
  const nonce = await queue.init();
  logger.info(`  account: ${account.address} (nonce ${nonce})`);
  logger.info(`  grace: ${grace} s`);
  for (const route of BASE_ROUTES) {
    logger.info(`  ${route.token}: ${route.sourceEmitter} @ ${WORMHOLE.hydration} -> ${route.transceiver}`);
  }

  const app = createApp(engineConfig(), {
    name: APP_NAME_BASE,
    retries: RETRIES_BASE,
    backoff: { baseMs: RETRY_BASE_MS, maxMs: RETRY_MAX_MS },
    startingSequence,
  });

  // Sends without a known outcome, across every job of this process (see `SentLedger`).
  const sent: SentLedger = new Map();

  for (const route of BASE_ROUTES) {
    const handle = async (ctx: RelayerCtx, next: Next): Promise<void> => {
      const { vaa } = ctx;
      const log = ctx.logger!.child({
        token: route.token,
        emitterChain: vaa.emitterChain,
        sequence: vaa.sequence.toString(),
      });
      const alert = discordAlert(alerts().discordWebhook, log);
      // relayer-engine passes the bullmq attempt count (from 1) and the budget on ctx.storage.job.
      const job = (ctx as { storage?: { job?: { attempts: number; maxAttempts: number } } }).storage?.job;
      const outcome = await runOutbound(route, vaa, clients, queue, log, { graceSeconds: grace, sent, alert }, job);
      log.info(`${route.token} to Base: ${outcome}`);
      return next();
    };
    // Through `onEmitter`: the engine's own lookup does not know chain 73.
    onEmitter(app, WORMHOLE.hydration, route.sourceEmitter, handle as never);
  }

  await app.listen();
}

boot("ntt-base", start);
