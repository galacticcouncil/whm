import { createPublicClient, createWalletClient, http, pad } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

import { boot } from "../../boot";
import { WORMHOLE } from "../../chains";
import { alerts, engineConfig, privateKey } from "../../config";
import { createApp } from "../../engine/app";
import { onEmitter } from "../../engine/emitter";
import {
  isNttTransfer,
  settlementAmount,
  settlementSequence,
  transferPayload,
  transferSender,
  transferTo,
} from "../../engine/ntt";
import { createQueue } from "../../engine/queue";
import { isDone, revertName } from "../../engine/revert";
import logger from "../../logger";
import type { Next, RelayerCtx } from "../../types";

import { forwarderAbi } from "./abi";
import { APP_NAME, FROM_SEQUENCE, RETRIES, RETRY_BASE_MS, RETRY_MAX_MS, RPC_ETHEREUM } from "./config";
import { forwardOf } from "./forward";
import { route } from "./routes";

/**
 * Intents v2 — the dispatcher on Hydration bridges WETH to the IntentForwarder over NTT, with the
 * forwarding instruction in the transfer's own payload. This calls
 * `IntentForwarder.processOrder(nttVaa, feeRequested)`, which delivers the settlement, pays the fee
 * and forwards the rest to POA's deposit address for the order's NEAR account.
 *
 * One VAA carries everything, so nothing is paired and the source transaction is never read — the
 * order is relayed the moment the spy delivers it, which matters: the router prices an order only
 * for a few minutes after it was signed, and POA credits about a minute after the Ethereum block.
 */
async function start(): Promise<void> {
  const { transceiver, dispatcher, forwarder } = route();
  const account = privateKeyToAccount(privateKey());

  const eth = createPublicClient({ chain: mainnet, transport: http(RPC_ETHEREUM) });
  const wallet = createWalletClient({ account, chain: mainnet, transport: http(RPC_ETHEREUM) });

  // The transfer names both as Wormhole universal addresses.
  const dispatcherKey = pad(dispatcher, { size: 32 }).slice(2).toLowerCase();
  const forwarderKey = pad(forwarder, { size: 32 }).slice(2).toLowerCase();

  // A forwarder pinning another dispatcher rejects every order this would pick out — refuse to run.
  const [pinned, authorized, allowlist] = await Promise.all([
    eth.readContract({ address: forwarder, abi: forwarderAbi, functionName: "dispatcher" }),
    eth.readContract({
      address: forwarder,
      abi: forwarderAbi,
      functionName: "authorizedRelayer",
      args: [account.address],
    }),
    eth.readContract({ address: forwarder, abi: forwarderAbi, functionName: "authorizedRelayerCount" }),
  ]);
  if (pinned.slice(2).toLowerCase() !== dispatcherKey) {
    throw new Error(`forwarder ${forwarder} pins dispatcher ${pinned}, routes.ts names ${dispatcher}`);
  }

  const queue = createQueue({ publicClient: eth, account, ...alerts() });

  const nonce = await queue.init();
  logger.info(`  account:     ${account.address} (nonce ${nonce})`);
  logger.info(`  transceiver: ${transceiver} @ hydration`);
  logger.info(`  dispatcher:  ${dispatcher} @ hydration`);
  logger.info(`  forwarder:   ${forwarder} @ ethereum`);
  if (allowlist > 0n && !authorized) {
    // Not fatal — orders still go through once their exclusive window lapses — but they lose it.
    logger.warn(`  ${account.address} is not an authorized relayer: every order waits out the window`);
  }

  /**
   * processOrder's arguments. Built in one place so the gas estimate and the submission are the
   * same call — an estimate of a slightly different call is worse than no estimate.
   */
  function orderArgs(nttVaa: Buffer, fee: bigint) {
    return [`0x${nttVaa.toString("hex")}`, fee] as const;
  }

  /**
   * What forwarding this order costs, measured rather than forecast: the real call's gas at the
   * order's own ceiling, the largest fee it can carry, priced at maxFeePerGas — the most the
   * transaction can cost.
   *
   * @param nttVaa The settlement.
   * @param ceiling The order's maxRelayFee.
   * @returns The fee to claim, in wei.
   * @throws The call's own revert, when the order is not deliverable at this block.
   */
  async function quote(nttVaa: Buffer, ceiling: bigint): Promise<bigint> {
    const [gas, fees] = await Promise.all([
      eth.estimateContractGas({
        address: forwarder,
        abi: forwarderAbi,
        functionName: "processOrder",
        args: orderArgs(nttVaa, ceiling),
        account,
      }),
      eth.estimateFeesPerGas(),
    ]);
    return gas * fees.maxFeePerGas;
  }

  /**
   * Deliver a settlement and forward it, in one call. Simulated first so a revert surfaces as a
   * named error before a nonce is spent.
   */
  async function forward(nttVaa: Buffer, fee: bigint, nonce: number) {
    const args = orderArgs(nttVaa, fee);

    await eth.simulateContract({
      address: forwarder,
      abi: forwarderAbi,
      functionName: "processOrder",
      args,
      account,
    });

    return wallet.writeContract({
      address: forwarder,
      abi: forwarderAbi,
      functionName: "processOrder",
      args,
      nonce,
      chain: mainnet,
      account,
    });
  }

  /**
   * Decide what to do with one settlement VAA.
   *
   * `next()` acks it: not ours, or already forwarded. Throwing hands it back for another attempt with
   * backoff, for what resolves on its own — the inbound rate limit releasing it, gas falling below
   * the order's ceiling, the exclusive window lapsing for a relayer outside it.
   */
  async function handle(ctx: RelayerCtx, next: Next): Promise<void> {
    const { vaa } = ctx;
    const attempt = ctx.storage?.job?.attempts ?? 0;

    // An order is the dispatcher's transfer to the forwarder. The forwarder checks the same before it
    // delivers anything; checking here keeps every other WETH transfer — v1's, a user's — from
    // costing a gas estimate.
    if (!isNttTransfer(vaa.payload)) return next();
    if (transferSender(vaa.payload) !== dispatcherKey) return next();
    if (transferTo(vaa.payload) !== forwarderKey) return next();

    const sequence = settlementSequence(vaa.payload);
    const log = ctx.logger!.child({ order: sequence.toString() });

    // The dispatcher always writes one, so this is a dispatcher we do not understand — worth seeing.
    const order = forwardOf(transferPayload(vaa.payload));
    if (!order) {
      log.error(`Order ${sequence} carries no forwarding instruction`);
      return next();
    }

    let fee: bigint;
    try {
      fee = await quote(vaa.bytes, order.maxRelayFee);
    } catch (e) {
      const name = revertName(e);
      if (isDone(name)) {
        log.info(`Order ${sequence} already forwarded`);
        return next();
      }
      log.warn(`Order ${sequence} not deliverable yet (${name ?? "no revert data"}); retrying`);
      throw e;
    }

    if (fee > order.maxRelayFee) {
      const reason =
        `Order ${sequence} unprofitable (attempt ${attempt}/${RETRIES}): ` +
        `fee ${fee} > ceiling ${order.maxRelayFee}; retrying with backoff`;
      log.warn(reason);
      throw new Error(reason);
    }

    log.info(
      `Order ${sequence}: ${settlementAmount(vaa.payload, 18)} wei -> ${order.depositAddress}, ` +
        `fee ${fee} <= ${order.maxRelayFee} (attempt ${attempt}/${RETRIES})`,
    );

    await queue.add({
      label: `order ${sequence}`,
      logger: log,
      submit: (n) => forward(vaa.bytes, fee, n),
    });
    return next();
  }

  const app = createApp(engineConfig(), {
    name: APP_NAME,
    retries: RETRIES,
    backoff: { baseMs: RETRY_BASE_MS, maxMs: RETRY_MAX_MS },
    startingSequence: FROM_SEQUENCE,
  });

  onEmitter(app, WORMHOLE.hydration, transceiver, handle as never);

  await app.listen();
}

boot("intent-v2", start);
