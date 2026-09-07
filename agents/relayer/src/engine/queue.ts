import { formatEther, formatGwei, type Account, type Hash, type PublicClient } from "viem";

import logger from "../logger";
import { isDone, revertName } from "./revert";

/** Enough gas for one submission; below this the process is out of runway and exits. */
const MIN_GAS = 1_000_000n;

const CHAIN_NAMES: Record<number, string> = {
  1: "ethereum",
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
   * @param nonce Nonce to submit under.
   * @returns The mined transaction hash.
   */
  submit(nonce: number): Promise<Hash>;
}

/** A queued task plus the settlement of the promise `add` handed its caller. */
interface Queued extends Task {
  resolve(): void;
  reject(err: unknown): void;
}

export interface QueueDeps {
  publicClient: PublicClient;
  account: Account;
  /** Alert sink for low/exhausted gas. Optional — omit to log only. */
  discordWebhook?: string;
  /** Warn when the balance drops below this multiple of one submission's cost. */
  warnMultiplier: bigint;
}

/**
 * Serialised, nonce-managed submission queue.
 *
 * The engine can hand us several VAAs at once, and a relayer wallet has one nonce — so submissions
 * run one at a time rather than racing. A task that fails for a reason that means "already done"
 * resolves; "nonce too low" reloads the nonce and retries in place; anything else rejects, because
 * only a proven outcome may be reported as one.
 */
export function createQueue(deps: QueueDeps) {
  const { publicClient, account, warnMultiplier } = deps;

  const pending: Queued[] = [];
  let nonce: number;
  let processing = false;
  let started = false;
  let lowBalanceWarned = false;
  let chainLabel: string | undefined;

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

  async function drain(): Promise<void> {
    if (processing || pending.length === 0) return;

    processing = true;
    const task = pending.shift()!;

    try {
      const hash = await task.submit(nonce);
      task.logger.info(`${task.label} submitted in ${hash}`);
      task.logger.info(`Next nonce: ${++nonce}`);
      task.resolve();
    } catch (e) {
      const name = revertName(e);
      const message = (e as Error).message ?? String(e);

      if (isDone(name)) {
        task.logger.info(`${task.label} already completed`);
        task.resolve();
      } else if (message.includes("nonce too low")) {
        task.logger.info("nonce too low, reloading");
        nonce = await publicClient.getTransactionCount({ address: account.address });
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
      nonce = await publicClient.getTransactionCount({ address: account.address });
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
     * @returns Resolves once submitted, or once the work turns out to be already done. Rejects on
     *          anything unproven, for the caller to hand back to the engine.
     */
    add(task: Task): Promise<void> {
      return new Promise<void>((resolve, reject) => {
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
