import { createPublicClient, createWalletClient, http, isAddressEqual, zeroAddress, type Address, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { boot } from "../../boot";
import { robinhood, ROBINHOOD_EVM_CHAIN_ID } from "../../chains";
import { alerts, engineConfig, privateKey } from "../../config";
import { createApp } from "../../engine/app";
import { onEmitter } from "../../engine/emitter";
import { createQueue } from "../../engine/queue";
import logger from "../../logger";
import type { Next, RelayerCtx } from "../../types";

import { receiverAbi } from "./abi";
import { APP_NAME, FROM_SEQUENCE, RETRIES, RPC_ROBINHOOD } from "./config";
import { ROUTES, type OracleRoute } from "./routes";

/**
 * Relays oracle price VAAs into Robinhood Chain. Each source chain's VAAs go to that source's own
 * OracleReceiver there, which verifies the emitter and writes the price in one call.
 */
async function start(): Promise<void> {
  for (const route of ROUTES) {
    if (isAddressEqual(route.sourceEmitter, zeroAddress) || isAddressEqual(route.receiver, zeroAddress)) {
      throw new Error(`[${route.source}] route unset — fill it from deployments/prod/oracle-relay-${route.source}.json`);
    }
  }

  const account = privateKeyToAccount(privateKey());
  const publicClient = createPublicClient({ chain: robinhood, transport: http(RPC_ROBINHOOD) });
  const wallet = createWalletClient({ account, chain: robinhood, transport: http(RPC_ROBINHOOD) });

  const chainId = await publicClient.getChainId();
  if (chainId !== ROBINHOOD_EVM_CHAIN_ID) {
    throw new Error(`RPC_ROBINHOOD returned chain ${chainId}; expected ${ROBINHOOD_EVM_CHAIN_ID}`);
  }

  const queue = createQueue({
    publicClient,
    account,
    ...alerts(),
  });

  const nonce = await queue.init();
  logger.info(`  account: ${account.address} (nonce ${nonce})`);
  for (const route of ROUTES) {
    logger.info(`  ${route.source} ${route.sourceEmitter} -> ${route.receiver} @ robinhood`);
  }

  /**
   * Submit `receiveMessage(vaa)` under a queue-owned nonce. Simulated first so a revert surfaces as
   * a named error before a nonce is spent — the queue then classifies it rather than burning gas.
   *
   * @param to The route's OracleReceiver.
   * @param vaaBytes The guardian-signed VAA.
   * @param n Nonce to submit under.
   * @returns The transaction hash.
   */
  async function receiveMessage(to: Address, vaaBytes: Buffer, n: number): Promise<Hash> {
    const args = [`0x${vaaBytes.toString("hex")}`] as const;

    await publicClient.simulateContract({
      address: to,
      abi: receiverAbi,
      functionName: "receiveMessage",
      args,
      account,
    });

    return wallet.writeContract({
      address: to,
      abi: receiverAbi,
      functionName: "receiveMessage",
      args,
      nonce: n,
      chain: robinhood,
      account,
    });
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
      submit: (n) => receiveMessage(route.receiver, vaa.bytes, n),
    });
    return next();
  }

  const app = createApp(engineConfig(), {
    name: APP_NAME,
    retries: RETRIES,
    startingSequence: FROM_SEQUENCE,
    sourceTx: true,
  });

  // Every source here is an EVM emitter on a chain the engine's SDK predates (Hydration), so the
  // subscription goes through onEmitter rather than `.address()`.
  for (const route of ROUTES) {
    onEmitter(app, route.sourceChain, route.sourceEmitter, ((ctx: RelayerCtx, next: Next) =>
      handle(route, ctx, next)) as never);
  }

  await app.listen();
}

boot("oracle-robinhood", start);
