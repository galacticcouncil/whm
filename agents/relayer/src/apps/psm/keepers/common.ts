import {
  BaseError,
  ContractFunctionRevertedError,
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  type Hash,
  type TransactionReceipt,
} from "viem";

import { submit, type Call, type ChainClients } from "../../../engine/hydration";
import type { Alerter } from "../../../engine/notify";
import type { Task } from "../../../engine/queue";
import logger from "../../../logger";

import { GAS_MARGIN_BPS, KEEPER_TX_STUCK_MS } from "../config";

/** How long a keeper waits for its own receipt before carrying the transaction as in flight. */
const RECEIPT_TIMEOUT_MS = 120_000;

export interface KeeperCtx {
  clients: ChainClients;
  /** The process's one queue, shared with deliveries: one wallet, one nonce lane. */
  queue: { add(task: Task): Promise<void> };
  alerter: Alerter;
  /** Whether keepers may send (`PSM_KEEPER`). Watchers run regardless. */
  enabled: boolean;
  log: typeof logger;
  now: () => number;
}

/** A keeper's own transaction, broadcast and not yet seen mined. */
export interface Inflight {
  hash: Hash;
  nonce: number;
  label: string;
  sentAt: number;
}

export type InflightStatus =
  | { kind: "mined"; receipt: TransactionReceipt }
  | { kind: "pending" }
  /** Its nonce was spent by another transaction, a replacement, so this hash never mines. */
  | { kind: "replaced" };

/**
 * Whether `e` is a contract revert, named or not, as opposed to an RPC or transport fault.
 *
 * viem files every -32603 as a `ContractFunctionRevertedError`, whatever its message, and drops the
 * code. A revert carries its revert bytes, or says it reverted: Base answers 3 "execution reverted",
 * Hydration -32603 "VM Exception while processing transaction: revert", both with the bytes.
 */
export function isRevert(e: unknown): boolean {
  if (!(e instanceof BaseError)) return false;
  const revert = e.walk((err) => err instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError)) return false;
  return (revert.raw !== undefined && revert.raw !== "0x") || /revert/i.test(revert.reason ?? "");
}

/**
 * Send one call through the shared queue, then wait for the receipt outside it, as deliveries do,
 * so the lane is free for the next task while this one mines. `submit` simulates first, so a revert
 * surfaces here, named, before a nonce is spent.
 *
 * @param opts `gasFloor`: the least gas limit to send with, whatever the estimate.
 * @returns The hash, and the receipt unless the wait for it failed: a transaction sent and not seen
 *          mined comes back as `inflight`, for the caller to carry. No hash means the queue judged
 *          the work already done and sent nothing.
 * @throws The queue's rejection (a revert or a fault), or when the receipt is another
 *         transaction's or a revert.
 */
export async function sendAndWait(
  ctx: KeeperCtx,
  call: Call,
  label: string,
  opts: { gasFloor?: bigint } = {},
): Promise<{ hash?: Hash; receipt?: TransactionReceipt; inflight?: Inflight }> {
  const sent: { tx?: Inflight } = {};
  await ctx.queue.add({
    label,
    logger: ctx.log,
    submit: async (nonce) => {
      const hash = await submit(ctx.clients, call, nonce, { gasMarginBps: GAS_MARGIN_BPS, gasFloor: opts.gasFloor });
      sent.tx = { hash, nonce, label, sentAt: ctx.now() };
      return hash;
    },
  });
  const tx = sent.tx;
  if (!tx) return {};

  let receipt: TransactionReceipt;
  try {
    receipt = await ctx.clients.publicClient.waitForTransactionReceipt({
      hash: tx.hash,
      timeout: RECEIPT_TIMEOUT_MS,
    });
  } catch (e) {
    // Broadcast and its nonce spent: whatever failed was the wait, not the transaction.
    if (!(e instanceof WaitForTransactionReceiptTimeoutError)) {
      ctx.log.warn(`${label}: receipt wait for ${tx.hash} failed: ${(e as Error).message}`);
    }
    return { hash: tx.hash, inflight: tx };
  }
  // viem follows a replacement at the same nonce; only this transaction's own receipt counts.
  if (receipt.transactionHash.toLowerCase() !== tx.hash.toLowerCase()) {
    throw new Error(`${label}: ${tx.hash} was replaced by ${receipt.transactionHash}`);
  }
  if (receipt.status !== "success") throw new Error(`${label}: ${tx.hash} reverted on chain`);
  return { hash: tx.hash, receipt };
}

/**
 * Look again at a keeper transaction still in flight.
 *
 * With no receipt for its hash once its nonce is spent, it was replaced, the usual fix for a stuck
 * transaction, and this hash never mines. Clearing one wrongly, on an RPC pool that answers from
 * nodes at different heights, costs at most one wasted transaction: both keepers simulate before
 * they send, and the contracts refuse work already done.
 *
 * Past `KEEPER_TX_STUCK_MS` unmined it is reported: the queue reloads its nonce only on "nonce too
 * low", so a transaction that never mines holds back everything after it on the wallet, deliveries
 * included, until a restart.
 */
export async function checkInflight(ctx: KeeperCtx, inflight: Inflight): Promise<InflightStatus> {
  const stuckKey = `psm:keeper-stuck:${inflight.hash}`;
  const receipt = await receiptOf(ctx, inflight.hash);
  if (receipt) {
    ctx.alerter.clear(stuckKey);
    return { kind: "mined", receipt };
  }

  const spent = await ctx.clients.publicClient.getTransactionCount({
    address: ctx.clients.account.address,
    blockTag: "latest",
  });
  if (spent > inflight.nonce) {
    // Mined between the two reads, or replaced.
    const late = await receiptOf(ctx, inflight.hash);
    ctx.alerter.clear(stuckKey);
    if (late) return { kind: "mined", receipt: late };
    ctx.log.warn(`${inflight.label}: ${inflight.hash} was replaced at nonce ${inflight.nonce}`);
    return { kind: "replaced" };
  }

  const age = ctx.now() - inflight.sentAt;
  if (age > KEEPER_TX_STUCK_MS) {
    ctx.alerter.alert(
      stuckKey,
      "stuck",
      `psm keeper: ${inflight.label} ${inflight.hash} unmined for ${Math.round(age / 60_000)} min; ` +
        `the wallet's nonce lane may be stuck, holding back deliveries too`,
    );
  }
  return { kind: "pending" };
}

async function receiptOf(ctx: KeeperCtx, hash: Hash): Promise<TransactionReceipt | undefined> {
  try {
    return await ctx.clients.publicClient.getTransactionReceipt({ hash });
  } catch (e) {
    if (e instanceof TransactionReceiptNotFoundError) return undefined;
    throw e;
  }
}

export const usdc = (v: bigint): string => `${(Number(v) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 })} USDC`;
