import { parseAbi } from "viem";

import { boot } from "../../boot";
import { hydration } from "../../chains";
import { alerts, engineConfig, privateKey } from "../../config";
import { createApp } from "../../engine/app";
import { hydrationClients, receiveMessage } from "../../engine/hydration";
import { isForManager, isNttTransfer } from "../../engine/ntt";
import { createQueue } from "../../engine/queue";
import logger from "../../logger";
import type { Next, RelayerCtx } from "../../types";
import { hydrationFees } from "../../utils/fees";

import { APP_NAME, FROM_SEQUENCE, RETRIES, RPC_HYDRATION } from "./config";
import { ROUTES, type NttRoute } from "./routes";

const transceiverAbi = parseAbi([
  "function receiveMessage(bytes encodedMessage) external",
  "error TransferAlreadyCompleted(bytes32 vaaHash)",
]);

/**
 * Redeems Wormhole NTT transfers into Hydration from every configured origin chain. Each route's
 * transfer VAA is submitted to that route's Hydration transceiver.
 */
async function start(): Promise<void> {
  const clients = await hydrationClients(RPC_HYDRATION, privateKey());
  const { account, publicClient } = clients;

  const queue = createQueue({
    publicClient,
    account,
    ...alerts(),
  });

  const nonce = await queue.init();
  logger.info(`  account: ${account.address} (nonce ${nonce})`);
  logger.info(`  watching ${ROUTES.length} NTT routes`);

  async function handle(route: NttRoute, ctx: RelayerCtx, next: Next): Promise<void> {
    const { vaa, sourceTxHash } = ctx;
    const log = ctx.logger!.child({
      token: route.token,
      sourceTxHash,
      emitterChain: vaa.emitterChain,
      sequence: vaa.sequence.toString(),
    });

    if (!isNttTransfer(vaa.payload)) {
      log.info("Ignoring non-transfer NTT transceiver message");
      return next();
    }

    if (!isForManager(vaa.payload, route.manager)) {
      log.info("Ignoring NTT transfer for another destination manager");
      return next();
    }

    await queue.add({
      label: `${route.token} transfer`,
      logger: log,
      // Hydration wants no priority fee, and some compatible RPCs omit
      // eth_maxPriorityFeePerGas. See utils/fees.
      submit: (n) =>
        receiveMessage(
          clients,
          hydration,
          hydrationFees,
          transceiverAbi,
          route.transceiver,
          vaa.bytes,
          n,
        ),
    });
    return next();
  }

  const app = createApp(engineConfig(), {
    name: APP_NAME,
    retries: RETRIES,
    startingSequence: FROM_SEQUENCE,
    sourceTx: true,
  });

  for (const route of ROUTES) {
    app
      .chain(route.sourceChain as never)
      .address(route.sourceEmitter, ((ctx: RelayerCtx, next: Next) =>
        handle(route, ctx, next)) as never);
  }

  await app.listen();
}

boot("ntt", start);
