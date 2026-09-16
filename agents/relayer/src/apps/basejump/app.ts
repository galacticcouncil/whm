import { decodeAbiParameters, parseAbi, parseAbiParameters, toHex } from "viem";

import { boot } from "../../boot";
import { alerts, engineConfig, privateKey } from "../../config";
import { createApp } from "../../engine/app";
import { hydrationClients, receiveMessage } from "../../engine/hydration";
import { createQueue } from "../../engine/queue";
import logger from "../../logger";
import type { Next, RelayerCtx } from "../../types";

import {
  APP_NAME,
  FROM_SEQUENCE,
  RETRIES,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  RPC_HYDRATION,
} from "./config";
import { ROUTES, type BasejumpRoute } from "./routes";

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
