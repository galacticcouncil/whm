import {
  formatEther,
  formatGwei,
  type Account,
  type Hash,
  type PublicClient,
  type TransactionReceipt,
} from "viem";

import logger from "../logger";
import { isDead, isDone, revertName } from "./revert";

/** Enough gas for one submission; below this the process is out of runway and exits. */
const MIN_GAS = 1_000_000n;

/** One wait for a send's receipt, before the queue re-reads the nonce on chain (viem's default). */
const RECEIPT_TIMEOUT_MS = 180_000;

/** Pause between two rounds that ended without a receipt, so an RPC that fails fast is not hammered. */
const ROUND_DELAY_MS = 5_000;

const CHAIN_NAMES: Record<number, string> = {
  1: "ethereum",
  4663: "robinhood",
  8453: "base",
  222222: "hydration",
  11155111: "sepolia",
  84532: "base-sepolia",
};

export interface Task {
  /** Short identifier for logs, e.g. the manager sequence or the token. */
  label: string;
  logger: typeof logger;
  /**
   * Send the transaction. The queue owns the nonce so submissions stay strictly ordered.
   *
   * May be called more than once for one task, always under the SAME nonce: when a send has no
   * receipt and the chain no longer knows it (dropped), the queue sends it again at that nonce.
   * At most one transaction per nonce can mine, so a second call never adds a second delivery.
   *
   * @param nonce Nonce to submit under.
   * @returns The broadcast transaction's hash (not yet mined).
   */
  submit(nonce: number): Promise<Hash>;
}

/** A queued task plus the settlement of the promise `add` handed its caller. */
interface Queued extends Task {
  resolve(receipt: TransactionReceipt | undefined): void;
  reject(err: unknown): void;
}

export interface QueueDeps {
  publicClient: PublicClient;
  account: Account;
  /** Alert sink for low/exhausted gas. Optional — omit to log only. */
  discordWebhook?: string;
  /** Warn when the balance drops below this multiple of one submission's cost. */
  warnMultiplier: bigint;
  /** One wait for a receipt before the nonce is re-read on chain; default 180 s. */
  receiptTimeoutMs?: number;
  /** Pause between two rounds that ended without a receipt; default 5 s. */
  roundDelayMs?: number;
}

/**
 * Serialised, nonce-managed submission queue.
 *
 * The engine can hand us several VAAs at once, and a relayer wallet has one nonce — so submissions
 * run one at a time rather than racing. A task that fails for a reason that means "already done"
 * resolves; "nonce too low" reloads the nonce and retries in place; anything else rejects, because
 * only a proven outcome may be reported as one.
 *
 * The lane holds a nonce until a transaction at that nonce is known to have mined. A send returns
 * a hash, not an outcome: the queue waits for the receipt (bounded per round) before it moves to
 * the next nonce, and hands the task its receipt. A round without a receipt re-reads the wallet's
 * nonce on chain:
 * - mined past it: the nonce is spent. A receipt for one of this task's own hashes is its outcome;
 *   none means another transaction took the nonce, so nothing this task sent can mine any more,
 *   and the task rejects for the engine to retry (the retry simulates again).
 * - not mined, but known pending: the send is still in a mempool; keep waiting (alerted once).
 * - neither: the send was dropped; send again at the SAME nonce (`submit` simulates again first).
 *
 * A send that fails WITHOUT a revert at a nonce the lane knows may be occupied (this task's earlier
 * send, or one an earlier task left unmined) is never the task's failure. A node that holds the
 * earlier send refuses a second one at the same nonce, under whatever wording it uses, and a node
 * behind a load balancer may not see that send at all. So the lane keeps holding and goes round
 * again (wait, re-read, send again at the same nonce) until the nonce mines, and no later task is
 * handed the occupied nonce in the meantime. Only a revert (the simulate's verdict) or a first send
 * at a nonce nothing is known to occupy leaves the lane with the task.
 *
 * So the lane never skips a nonce (a dropped send no longer strands every later one behind a gap),
 * and a message is never sent at a later nonce while an earlier send of it can still mine (a late
 * first send can no longer turn the retry into a reverted, gas-burning replay). Every repeat of a
 * send uses the nonce of the first, and one nonce mines once. The cost is throughput and liveness:
 * one transaction in flight per wallet, and a nonce held by a send that never mines and never
 * leaves every mempool (stuck underpriced; there is no fee bump) holds the lane: later tasks wait
 * behind it, unsent, while it is logged each round and alerted once per task that waits on it. A
 * mined transaction retracted by a reorg and then dropped (the chain's nonce falls below the lane)
 * is not recovered: the lane stays above the chain until a restart.
 */
export function createQueue(deps: QueueDeps) {
  const { publicClient, account, warnMultiplier } = deps;

  const pending: Queued[] = [];
  let nonce: number;
  let processing = false;
  let started = false;
  let lowBalanceWarned = false;
  let chainLabel: string | undefined;
  /**
   * A nonce a task left the lane at after broadcasting there, without that nonce being seen mined
   * (its repeat send simulated as done or dead). A send may still be pending at it.
   */
  let occupiedAt: number | undefined;

  /** Move the lane to `to`; whatever occupied the old nonce no longer matters. */
  function advance(to: number): void {
    nonce = to;
    occupiedAt = undefined;
  }

  async function label(): Promise<string> {
    if (chainLabel) return chainLabel;
    const id = await publicClient.getChainId();
    chainLabel = `${CHAIN_NAMES[id] ?? "chain"} (${id})`;
    return chainLabel;
  }

  async function notifyDiscord(message: string): Promise<void> {
    if (!deps.discordWebhook) return;
    try {
      await fetch(deps.discordWebhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: message }),
      });
    } catch (e) {
      logger.error(`Failed to send Discord notification: ${(e as Error).message}`);
    }
  }

  /** Exit rather than submit into a wallet that cannot pay — a half-sent queue is worse. */
  async function checkBalance(): Promise<void> {
    const [balance, gasPrice, chain] = await Promise.all([
      publicClient.getBalance({ address: account.address }),
      publicClient.getGasPrice(),
      label(),
    ]);

    const minBalance = gasPrice * MIN_GAS;
    const warnBalance = minBalance * warnMultiplier;
    const multiplier = minBalance > 0n ? Number((balance * 100n) / minBalance) / 100 : 0;
    const pct = Math.min(100, Math.round((multiplier / Number(warnMultiplier)) * 100));
    const bar =
      "█".repeat(Math.round((pct / 100) * 20)) + "░".repeat(20 - Math.round((pct / 100) * 20));

    const summary =
      `${chain} | \`${account.address}\` | ${multiplier.toFixed(1)}x/${warnMultiplier}x ` +
      `[${bar}] ${pct}% | ${(+formatEther(balance)).toFixed(4)} ETH @ ` +
      `${(+formatGwei(gasPrice)).toFixed(2)} gwei`;

    if (balance < minBalance) {
      const msg = `KILL out of gas | ${summary}`;
      logger.error(msg);
      if (started) await notifyDiscord(msg);
      process.exit(1);
    }

    if (balance < warnBalance) {
      if (!lowBalanceWarned) {
        const msg = `WARN low gas | ${summary}`;
        logger.warn(msg);
        await notifyDiscord(msg);
        lowBalanceWarned = true;
      }
    } else {
      lowBalanceWarned = false;
    }

    logger.info(`Gas: ${summary}`);
  }

  const receiptTimeoutMs = deps.receiptTimeoutMs ?? RECEIPT_TIMEOUT_MS;
  const roundDelayMs = deps.roundDelayMs ?? ROUND_DELAY_MS;

  /** The receipt for `hash` (or a same-nonce replacement viem followed), or undefined if none came. */
  async function waitReceipt(task: Task, hash: Hash): Promise<TransactionReceipt | undefined> {
    try {
      return await publicClient.waitForTransactionReceipt({ hash, timeout: receiptTimeoutMs });
    } catch (e) {
      task.logger.warn(`${task.label}: no receipt for ${hash}: ${(e as Error).message?.split("\n")[0]}`);
      return undefined;
    }
  }

  /** The receipt of the first of `hashes` that has one; undefined when none has. */
  async function anyReceipt(hashes: Hash[]): Promise<TransactionReceipt | undefined> {
    for (const hash of hashes) {
      const receipt = await publicClient.getTransactionReceipt({ hash }).catch(() => undefined);
      if (receipt) return receipt;
    }
    return undefined;
  }

  /**
   * Hold the lane at nonce `n` until a transaction at `n` is known to have mined, and return this
   * task's receipt. Moves the lane past `n` exactly when `n` is known spent.
   *
   * @param first The task's first send at `n`, or undefined when that send failed without a revert
   *   (`refused`): then nothing of this task is known to be out, and the round sends again at `n`.
   * @returns The receipt, or "requeue" when `n` mined while this task had nothing out at it (the
   *   task goes again at the new nonce).
   * @throws When `n` was spent by a transaction this task did not send (nothing it sent can mine
   *   now); a revert from a repeat send (the outer classification applies); or `refused` itself when
   *   nothing is known to occupy `n` (a failure before anything went out, e.g. an RPC error).
   */
  async function settle(
    task: Task,
    n: number,
    first: Hash | undefined,
    refused?: unknown,
  ): Promise<TransactionReceipt | "requeue"> {
    const sent: Hash[] = first ? [first] : [];
    const ours = (r: TransactionReceipt) =>
      sent.some((h) => h.toLowerCase() === r.transactionHash.toLowerCase());
    const pause = () =>
      roundDelayMs > 0 ? new Promise((r) => setTimeout(r, roundDelayMs)) : Promise.resolve();
    const count = (blockTag: "latest" | "pending") =>
      publicClient
        .getTransactionCount({ address: account.address, blockTag })
        .catch((e: Error) => {
          task.logger.warn(`${task.label}: ${blockTag} nonce read failed: ${e.message?.split("\n")[0]}`);
          return undefined;
        });
    let alerted = false;
    let wait = sent.length > 0;

    for (let round = 1; ; round++) {
      const receipt = wait ? await waitReceipt(task, sent[sent.length - 1]) : undefined;
      if (!wait) await pause();
      wait = sent.length > 0;
      if (receipt) {
        // A receipt means nonce n mined. viem follows a same-nonce replacement and returns ITS
        // receipt, so check the hash: only a transaction this task sent is this task's outcome.
        advance(n + 1);
        if (ours(receipt)) return receipt;
        throw new Error(
          `${task.label}: nonce ${n} was taken by ${receipt.transactionHash}, not by this task's ` +
            `${sent.join(", ")}; nothing it sent can mine now`,
        );
      }

      const mined = await count("latest");
      if (mined !== undefined && mined > n) {
        if (sent.length === 0) {
          // Nothing of this task's is out: whatever held n mined. Go again at the chain's nonce.
          advance(mined);
          return "requeue";
        }
        advance(n + 1);
        const own = await anyReceipt(sent);
        if (own) return own;
        throw new Error(
          `${task.label}: nonce ${n} mined, and no receipt for this task's ${sent.join(", ")}; ` +
            `another transaction took it, or the node lags (the retry simulates again)`,
        );
      }

      const held =
        `${await label().catch(() => "chain")} lane held at nonce ${n} by ${task.label} ` +
        `(${sent.length ? sent.join(", ") : "send refused"}), round ${round}`;

      const known = mined === undefined ? undefined : await count("pending");
      const occupied = sent.length > 0 || occupiedAt === n || (known !== undefined && known > n);
      if (!occupied) {
        // This task sent nothing and nothing is known at n: the first send's failure stands.
        throw refused;
      }
      if (!alerted) {
        alerted = true;
        await notifyDiscord(`WARN ${held}: no receipt yet`);
      }
      if (known === undefined || known > n) {
        // Still pending in a mempool, or the chain could not be read: keep the nonce, wait again.
        task.logger.warn(`${held}: ${known === undefined ? "nonce unreadable" : "still pending"}, waiting`);
        if (sent.length > 0) await pause();
        else wait = false;
        continue;
      }

      // Not mined and not pending on this node: send again under the same nonce.
      task.logger.warn(`${held}: not mined and not pending, sending again at nonce ${n}`);
      try {
        const again = await task.submit(n);
        task.logger.info(`${task.label} sent again in ${again} (nonce ${n})`);
        sent.push(again);
        wait = true;
      } catch (e) {
        if (revertName(e) !== undefined) {
          // The simulate's verdict leaves the lane, but a send of ours may still be out at n.
          if (sent.length > 0) occupiedAt = n;
          throw e;
        }
        // Any other refusal ("already known", "replacement transaction underpriced", "nonce too
        // low", a pool error in any wording, an RPC error): n may be occupied by a send this node
        // cannot see. Hold, and read again next round; never hand n to the next task.
        task.logger.warn(`${task.label}: send at nonce ${n} refused, holding: ${(e as Error).message?.split("\n")[0]}`);
        if (sent.length > 0) await pause();
        else wait = false;
      }
    }
  }

  async function drain(): Promise<void> {
    if (processing || pending.length === 0) return;

    processing = true;
    const task = pending.shift()!;
    const n = nonce;

    try {
      let hash: Hash | undefined;
      let refused: unknown;
      try {
        hash = await task.submit(n);
        task.logger.info(`${task.label} submitted in ${hash} (nonce ${n})`);
      } catch (e) {
        // A revert is the simulate's verdict: classified below. Anything else may be a refusal of
        // a nonce another send occupies; `settle` decides, never the error's wording.
        if (revertName(e) !== undefined) throw e;
        refused = e;
      }
      const receipt = await settle(task, n, hash, refused);
      if (receipt === "requeue") {
        task.logger.info(`${task.label}: nonce ${n} mined meanwhile, going again at ${nonce}`);
        pending.unshift(task);
        return;
      }
      task.logger.info(`${task.label} mined in ${receipt.transactionHash} (${receipt.status})`);
      task.logger.info(`Next nonce: ${nonce}`);
      task.resolve(receipt);
    } catch (e) {
      const name = revertName(e);
      const message = (e as Error).message ?? String(e);

      if (isDone(name)) {
        // The name says which kind of done: a replayed VAA, or — on the PSM receivers — a second
        // signed copy of a message they already consumed (see DONE_ERRORS in ./revert).
        task.logger.info(`${task.label} already completed (${name})`);
        task.resolve(undefined);
      } else if (isDead(name)) {
        // Nothing was written and no retry can change that — drop it, but at warn: a VAA that aged
        // out of maxPriceAge is a real gap in the feed, not a completion.
        task.logger.warn(`${task.label} dropped, cannot succeed (${name})`);
        task.resolve(undefined);
      } else if (message.includes("nonce too low")) {
        task.logger.info("nonce too low, reloading");
        advance(await publicClient.getTransactionCount({ address: account.address }));
        pending.unshift(task);
      } else {
        // Not proven finished — a queued settlement, a failing forward, an RPC blip. Hand it
        // back so the engine retries with backoff rather than acking a failure as a success.
        task.logger.warn(`${task.label} failed${name ? ` (${name})` : ""}: ${message}`);
        task.reject(e);
      }
    } finally {
      processing = false;
      await checkBalance();
      void drain();
    }
  }

  return {
    /** Load the starting nonce and assert the wallet can pay. Call once before listening. */
    async init(): Promise<number> {
      await checkBalance();
      started = true;
      advance(await publicClient.getTransactionCount({ address: account.address }));
      return nonce;
    },

    /**
     * Queue one submission.
     *
     * Awaiting the result is what keeps the submission inside the caller's workflow: a rejection
     * here surfaces as a handler throw, which is the only thing the engine will retry. Discard it
     * and a failed transaction is indistinguishable from a delivered one.
     *
     * @param task What to send, and how to label it in the log.
     * @returns The receipt of a transaction this task sent, once mined (success OR reverted: the
     *          caller reads `status`); undefined when the simulate said the work is already done
     *          (or can never succeed). Undefined does NOT mean nothing went out: when that verdict
     *          came on a repeat send, the first send may still be pending and may still mine.
     *          Rejects on anything unproven, for the caller to hand back to the engine.
     */
    add(task: Task): Promise<TransactionReceipt | undefined> {
      return new Promise<TransactionReceipt | undefined>((resolve, reject) => {
        pending.push({ ...task, resolve, reject });
        void drain();
      });
    },

    get nonce(): number {
      return nonce;
    },
  };
}

export type Queue = ReturnType<typeof createQueue>;
