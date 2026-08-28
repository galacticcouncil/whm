import { parseAbi } from "viem";

import { boot } from "../../boot";
import { alerts, engineConfig, privateKey } from "../../config";
import { createApp } from "../../engine/app";
import { hydrationClients, receiveMessage } from "../../engine/hydration";
import { createQueue } from "../../engine/queue";
import logger from "../../logger";
import type { Next, RelayerCtx } from "../../types";

import { APP_NAME, FROM_SEQUENCE, RETRIES, RPC_HYDRATION } from "./config";
import { ROUTES, type OracleRoute } from "./routes";

const receiverAbi = parseAbi(["function receiveMessage(bytes vaa) external"]);

/**
 * Relays oracle price VAAs into Hydration. Each source chain's VAAs go to that source's own
 * OracleReceiver, which verifies the emitter and writes the price in one call.
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
  for (const route of ROUTES) {
    logger.info(`  ${route.source} ${route.sourceEmitter} -> ${route.receiver}`);
  }

  async function handle(route: OracleRoute, ctx: RelayerCtx, next: Next): Promise<void> {
    const { vaa, sourceTxHash } = ctx;
    const log = ctx.logger!.child({
      source: route.source,
      sourceTxHash,
      sequence: vaa.sequence.toString(),
    });

    await queue.add({
      label: `${route.source} oracle`,
      logger: log,
      submit: (n) => receiveMessage(clients, receiverAbi, route.receiver, vaa.bytes, n),
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

boot("oracle", start);
