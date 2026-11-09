import { decodeAbiParameters, parseAbi, parseAbiParameters, toHex } from "viem";

import { boot } from "../../boot";
import { alerts, engineConfig, privateKey } from "../../config";
import { hydrationClients, receiveMessage } from "../../clients/hydration";
import { createApp } from "../../engine/app";
import { createQueue } from "../../engine/queue";
import logger from "../../logger";
import type { Next, RelayerCtx } from "../../types";

import {
  APP_NAME,
  FROM_SEQUENCE,
  QUEUED_PAYOUT_ALERT_MS,
  QUEUED_PAYOUT_MAX_PER_RUN,
  QUEUED_PAYOUT_POLL_MS,
  QUEUED_PAYOUT_RECEIPT_TIMEOUT_MS,
  RETRIES,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  RPC_HYDRATION,
} from "./config";
import { createPayoutKeeper, discordNotifier, landingsOf } from "./payouts";
import { ROUTES as ALL_ROUTES, isDeployed, type BasejumpRoute } from "./routes";

// A corridor whose migration has not run has no emitter to subscribe to. Skipped, loudly, rather
// than refusing to start: refusing would also stop the corridors that are live.
const ROUTES = ALL_ROUTES.filter(isDeployed);

// `completeTransfer` is a thin alias over the inherited public `receiveMessage`; submitting the
// latter keeps the shared Hydration helper. Errors declared so a revert is logged by name — the
// landing's bubble up through the receiver unchanged.
const receiverAbi = parseAbi([
  "function receiveMessage(bytes vaa) external",
  "error NotAuthorizedEmitter()",
  "error LandingNotSet()",
  "error NotAuthorizedBridge()",
  "error AssetNotConfigured(address sourceAsset)",
  "error DispatchFailed()",
]);

/** `abi.encode(TransferPayload)` — the fast-path wire format, decoded for the log line only. */
const transferPayload = parseAbiParameters(
  "(address sourceAsset, uint256 amount, bytes32 recipient, uint64 transferSequence, bytes data)",
);

/**
 * Relays Basejump fast-path VAAs into Hydration. Each corridor's emitter publishes a net payout
 * instruction; its own BasejumpReceiver verifies the emitter and pays out of the shared landing in
 * one call. A landing revert unwinds the VAA, so a retry is always safe.
 *
 * A landing short of float queues the payout instead. The same wallet then pays queued payouts as
 * soon as the pool covers them (payouts.ts), after every delivery and on a timer.
 */
async function start(): Promise<void> {
  const clients = await hydrationClients(RPC_HYDRATION, privateKey());
  const { account, publicClient } = clients;

  const alerting = alerts();
  const queue = createQueue({
    publicClient,
    account,
    ...alerting,
  });

  const nonce = await queue.init();
  logger.info(`  account: ${account.address} (nonce ${nonce})`);
  for (const route of ROUTES) {
    logger.info(`  ${route.source} ${route.sourceEmitter} -> ${route.receiver}`);
  }
  for (const route of ALL_ROUTES.filter((r) => !isDeployed(r))) {
    logger.warn(`  ${route.source} NOT RELAYED: addresses not filled in routes.ts`);
  }

  // Queued payouts go through the app's send queue, so they never use a delivery's nonce. They do
  // compete with deliveries for the float; payouts.ts retries a call that loses that race.
  const keepers = (await landingsOf(clients, ROUTES.map((r) => r.receiver))).map((landing) => {
    logger.info(`  queued payouts: landing ${landing}, every ${QUEUED_PAYOUT_POLL_MS / 1000}s`);
    return createPayoutKeeper({
      clients,
      queue,
      landing,
      alertAfterMs: QUEUED_PAYOUT_ALERT_MS,
      maxPerRun: QUEUED_PAYOUT_MAX_PER_RUN,
      receiptTimeoutMs: QUEUED_PAYOUT_RECEIPT_TIMEOUT_MS,
      notify: discordNotifier(alerting.discordWebhook),
    });
  });
  for (const keeper of keepers) {
    keeper.start(QUEUED_PAYOUT_POLL_MS);
    void keeper.poke();
  }

  async function handle(route: BasejumpRoute, ctx: RelayerCtx, next: Next): Promise<void> {
    const { vaa, sourceTxHash } = ctx;
    const [payout] = decodeAbiParameters(transferPayload, toHex(vaa.payload));
    const log = ctx.logger!.child({
      source: route.source,
      sourceTxHash,
      sequence: vaa.sequence.toString(),
      transferSequence: payout.transferSequence.toString(),
      asset: payout.sourceAsset,
      amount: payout.amount.toString(),
      recipient: payout.recipient,
    });

    await queue.add({
      label: `${route.source} basejump #${vaa.sequence}`,
      logger: log,
      submit: (n) => receiveMessage(clients, receiverAbi, route.receiver, vaa.bytes, n),
    });
    // A delivery may have queued its payout, or the pool may have been refilled since the last
    // pass. Not awaited: the keeper never throws, and the delivery's job is already done.
    for (const keeper of keepers) void keeper.poke();
    return next();
  }

  // No sourceTx: the hash is not needed, and waiting on Wormholescan would cost the payout the very
  // seconds the fast path exists to save.
  const app = createApp(engineConfig(), {
    name: APP_NAME,
    retries: RETRIES,
    backoff: { baseMs: RETRY_BASE_MS, maxMs: RETRY_MAX_MS },
    startingSequence: FROM_SEQUENCE,
  });

  for (const route of ROUTES) {
    app
      .chain(route.sourceChain as never)
      .address(route.sourceEmitter, ((ctx: RelayerCtx, next: Next) =>
        handle(route, ctx, next)) as never);
  }

  await app.listen();
}

boot("basejump", start);
