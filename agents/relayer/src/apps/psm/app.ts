import type { Hash } from "viem";

import { alerts, engineConfig } from "../../config";
import { createApp } from "../../engine/app";
import { onEmitter } from "../../engine/emitter";
import { createQueue, type Queue } from "../../engine/queue";
import type { ChainClients } from "../../engine/hydration";
import { receiveMessage } from "../../engine/hydration";
import logger from "../../logger";
import type { ChainId, Next, RelayerApp, RelayerCtx } from "../../types";

import { receiverAbi } from "./abi";
import { RETRIES, RETRY_BASE_MS, RETRY_MAX_MS } from "./config";
import { routesFor, type PsmRoute } from "./routes";

/**
 * Builds `{ account, publicClient, wallet }` for the destination this process owns, and asserts
 * the RPC is the chain it thinks it is — the same contract `hydrationClients` and `baseClients`
 * already uphold. The destination chain itself travels on `wallet.chain`, not as a separate field;
 * kept as an injected parameter, not an import chosen by chain id, so this file never has to know
 * how many destination chains exist.
 */
export type ClientFactory = (rpcUrl: string, key: `0x${string}`) => Promise<ChainClients>;

/**
 * Subscribe every route landing on `clients`'s chain, submitting each through the same queue and
 * clients.
 *
 * Pulled out of `makeApp` so it can be driven directly, with a fake `app` and a fake `queue`, no
 * engine and no network — that is how `scripts/verify-psm-app.ts` proves destination-keying and the
 * second-route claim: this function does not read `clients`'s destination identity anywhere, only
 * `route.sourceChain` / `route.sourceEmitter` (what to subscribe to) and
 * `route.destinationContract` (what to submit to). A route whose fields happen to describe the
 * opposite direction runs through the exact same code.
 *
 * Always registers through `onEmitter` rather than `app.chain(id).address(...)` — `onEmitter`
 * bypasses relayer-engine's SDK-chain lookup entirely (see its own doc comment), which
 * `.address()` cannot do for a source chain the bundled SDK predates. Hydration (73) is one such
 * source (the redeem/refund route), so a uniform subscription path is what keeps a route's shape
 * identical regardless of which chain it names as source.
 *
 * @param app Engine app to register the subscriptions on.
 * @param routes Routes to serve — every one is wired, none is skipped or treated as default.
 * @param clients Destination chain's account and clients, built once for the process.
 * @param queue Shared submission queue for this process's single wallet.
 */
export function wireRoutes(app: RelayerApp, routes: PsmRoute[], clients: ChainClients, queue: Queue): void {
  for (const route of routes) {
    async function handle(ctx: RelayerCtx, next: Next): Promise<void> {
      const { vaa, sourceTxHash } = ctx;
      const log = ctx.logger!.child({
        route: route.name,
        sourceChain: route.sourceChain,
        sourceTxHash,
        sequence: vaa.sequence.toString(),
      });

      // The queue resolves a task once its transaction is broadcast, or once the work turns out to
      // be done already, and never reads a receipt. A delivery that simulated clean can still
      // revert on chain: a pause or a spent limit landing first in the same block, or a gas limit
      // estimated on the other path. So keep the hash, read the receipt once the queue lets go of
      // the task, and throw on a revert: the engine then retries the job with backoff, and the
      // retry simulates again, so a pause is named and waited out and a delivery that someone else
      // made reads as done. No hash means nothing was sent (the work was already done), so there
      // is no receipt to read.
      const sent: { hash?: Hash } = {};
      await queue.add({
        label: route.name,
        logger: log,
        submit: async (n) =>
          (sent.hash = await receiveMessage(clients, receiverAbi, route.destinationContract, vaa.bytes, n)),
      });
      if (sent.hash) {
        const receipt = await clients.publicClient.waitForTransactionReceipt({ hash: sent.hash });
        if (receipt.status !== "success") {
          throw new Error(`psm ${route.name}: delivery ${sent.hash} reverted on chain`);
        }
      }
      return next();
    }

    onEmitter(app, route.sourceChain, route.sourceEmitter, handle as never);
  }
}

/**
 * Boot one destination process: resolve the routes landing on it, build that chain's clients and
 * wallet-owned submission queue, wire every matching route, and start listening.
 *
 * This is the whole reason a corridor addition can be "a route entry plus a funded wallet, no new
 * process": adding a route whose `destinationChain` already has a process just changes what
 * `routesFor` returns here, on the next deploy of that same process. A destination this process
 * does not yet cover is a new call site (see `hydration.ts` / `base.ts`) with its own
 * `ClientFactory`, RPC, and namespace — never a change to this function.
 *
 * @param name Engine namespace for this process — LOAD-BEARING, see `../../engine/app`'s
 *   `AppOptions.name`.
 * @param destinationChain Wormhole chain id this process's wallet delivers to.
 * @param clientFactory Builds this destination's clients (`hydrationClients` or `baseClients`).
 * @param rpcUrl RPC for `destinationChain`.
 * @param key This process's own signing key — resolved by the caller (`privateKey()` for
 *   Hydration, `privateKeyBase()` for Base — see `hydration.ts` / `base.ts`), not read from env
 *   here. Base's key isolation from every other chain's wallet depends on which env var the
 *   CALLER resolved this from; this function stays agnostic to that so it never has an opinion on
 *   which chain gets which key name.
 * @param startingSequence Cold-start floor per source chain this process subscribes to.
 * @throws When `routesFor` finds no route for `destinationChain`, or a matching route carries a
 *   blank or malformed address (see `./routes`).
 */
export async function makeApp(
  name: string,
  destinationChain: ChainId,
  clientFactory: ClientFactory,
  rpcUrl: string,
  key: `0x${string}`,
  startingSequence?: Record<ChainId, bigint>,
): Promise<void> {
  const routes = routesFor(destinationChain);
  if (routes.length === 0) {
    throw new Error(`psm: no routes configured for destination chain ${destinationChain}`);
  }

  const clients = await clientFactory(rpcUrl, key);
  const { account, publicClient } = clients;

  const queue = createQueue({ publicClient, account, ...alerts() });
  const nonce = await queue.init();
  logger.info(`  account: ${account.address} (nonce ${nonce})`);
  logger.info(`  destination chain: ${destinationChain}`);
  for (const route of routes) {
    logger.info(`  ${route.name}: ${route.sourceEmitter} @ ${route.sourceChain} -> ${route.destinationContract}`);
  }

  const app = createApp(engineConfig(), {
    name,
    retries: RETRIES,
    backoff: { baseMs: RETRY_BASE_MS, maxMs: RETRY_MAX_MS },
    startingSequence,
  });

  wireRoutes(app, routes, clients, queue);

  await app.listen();
}
