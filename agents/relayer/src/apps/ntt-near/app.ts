import { createHash } from "node:crypto";

import { createPublicClient, http, type Hash } from "viem";

import { boot } from "../../boot";
import { WORMHOLE } from "../../chains";
import { engineConfig } from "../../config";
import { complete, isDoneOnNear, nearClients, serial } from "../../clients/near";
import { createApp } from "../../engine/app";
import { onEmitter } from "../../engine/emitter";
import { isNttTransfer, recipientManager, settlementSequence } from "../../engine/ntt";
import { normalizeTxHash } from "../../engine/vaa";
import logger from "../../logger";
import type { Next, RelayerCtx } from "../../types";

import { APP_NAME, FROM_SEQUENCE, RETRIES, RPC_HYDRATION, RPC_NEAR } from "./config";
import { assertRoutes, ROUTES, type NearRoute } from "./routes";
import { findAccount } from "./withdrawal";

/**
 * UTXO withdrawals — Hydration settles a coin to NEAR over NTT for the account its destination
 * address derives, and the coin's emitter logs that account beside it. This completes the
 * settlement on NEAR for it: nobody holds a key for a derived account, so somebody has to.
 *
 * Only the settlements are subscribed to. A NEAR transfer names its recipient as
 * `sha256(account_id)`, which cannot be inverted, so the account is read from the source
 * transaction on demand.
 */
async function start(): Promise<void> {
  assertRoutes();

  // Read-only: the source tx receipt the account is found in.
  const hydration = createPublicClient({ transport: http(RPC_HYDRATION) });
  const near = nearClients(RPC_NEAR);
  const run = serial();

  const balance = await near.account.getBalance();
  logger.info(`  account: ${near.account.accountId} (${balance} yocto)`);
  logger.info(`  watching ${ROUTES.length} routes`);

  /**
   * Decide what to do with one settlement VAA. `next()` acks it — not ours, or already done;
   * throwing hands it back for another attempt with backoff.
   */
  async function handle(route: NearRoute, ctx: RelayerCtx, next: Next): Promise<void> {
    const { vaa, sourceTxHash } = ctx;
    const log = ctx.logger!.child({
      token: route.token,
      sourceTxHash,
      sequence: vaa.sequence.toString(),
    });

    if (!isNttTransfer(vaa.payload)) {
      log.info("Ignoring non-transfer NTT transceiver message");
      return next();
    }

    const managerHash = createHash("sha256").update(route.manager).digest("hex");
    if (recipientManager(vaa.payload) !== managerHash) {
      log.info("Ignoring NTT transfer for another destination manager");
      return next();
    }

    if (!sourceTxHash) {
      log.warn("Source tx hash unavailable; retrying...");
      throw new Error("Source tx hash unavailable; retrying...");
    }

    const sequence = settlementSequence(vaa.payload);
    const account = await findAccount(
      hydration,
      route.emitter,
      normalizeTxHash(sourceTxHash) as Hash,
      sequence,
    );

    if (!account) {
      log.info(`Settlement ${sequence} carries no withdrawal`);
      return next();
    }

    try {
      const hash = await run(() => complete(near, route.manager, vaa.bytes, account));
      log.info(`Settlement ${sequence} completed for ${account}: ${hash}`);
    } catch (e) {
      if (!isDoneOnNear(e)) throw e;
      log.info(`Settlement ${sequence} already completed`);
    }
    return next();
  }

  const app = createApp(engineConfig(), {
    name: APP_NAME,
    retries: RETRIES,
    startingSequence: FROM_SEQUENCE,
    // The account is found in the source transaction, so the hash is worth waiting for.
    sourceTx: true,
  });

  for (const route of ROUTES) {
    const handler = (ctx: RelayerCtx, next: Next) => handle(route, ctx, next);
    onEmitter(app, WORMHOLE.hydration, route.transceiver, handler as never);
  }

  await app.listen();
}

boot("ntt-near", start);
