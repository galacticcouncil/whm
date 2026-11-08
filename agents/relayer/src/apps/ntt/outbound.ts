import {
  concat,
  decodeEventLog,
  formatUnits,
  keccak256,
  parseAbi,
  toHex,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Hash,
  type Hex,
  type TransactionReceipt,
} from "viem";

import type { ChainClients } from "../../clients/hydration";
import { receiveMessage } from "../../clients/hydration";
import { isForManager, isNttTransfer } from "../../engine/ntt";
import type { Queue } from "../../engine/queue";
import type logger from "../../logger";
import type { ParsedVaa } from "../../types";

import type { OutboundNttRoute } from "./routes";

export const outboundAbi = parseAbi([
  "function receiveMessage(bytes encodedMessage) external",
  "function isVAAConsumed(bytes32 hash) external view returns (bool)",
  "function isMessageExecuted(bytes32 digest) external view returns (bool)",
  "function getInboundQueuedTransfer(bytes32 digest) external view returns ((uint72 amount, uint64 txTimestamp, address recipient))",
  "function rateLimitDuration() external view returns (uint64)",
  // The manager's two outcomes of an executed inbound transfer, emitted in the delivering
  // transaction: held by the inbound rate limiter (RateLimiter._enqueueInboundTransfer; digest not
  // indexed), or released to the recipient (NttManager._mintOrUnlockToRecipient). Read from the
  // receipt, so the verdict comes from the delivery itself and not from a later state read.
  "event InboundTransferQueued(bytes32 digest)",
  "event TransferRedeemed(bytes32 indexed digest)",
  "error TransferAlreadyCompleted(bytes32 vaaHash)",
  // The transceiver's refusal of a VAA that does not verify. Named here for the log only, and
  // retried like any other revert: it also covers a valid VAA signed by a guardian set Base has
  // not been given yet, so it is not proof the VAA is bad. Retries only simulate, so they cost no gas.
  "error InvalidVaa(string reason)",
]);

/**
 * Offsets into the transceiver payload past those `engine/ntt.ts` documents: the manager message
 * runs from byte 70 for the length at byte 68, and the transfer's `toChain` sits after
 * prefix (4) · decimals (1) · amount (8) · sourceToken (32) · to (32), counted from byte 136.
 */
const MANAGER_MESSAGE_LENGTH_OFFSET = 68;
const MANAGER_MESSAGE_OFFSET = 70;
const TO_CHAIN_OFFSET = 136 + 4 + 1 + 8 + 32 + 32;

/** Each guardian signature is index (1) · r (32) · s (32) · v (1). */
const SIGNATURE_LENGTH = 66;

/**
 * The hash the transceiver marks consumed: Wormhole's `vm.hash`, keccak256 of keccak256 of the VAA
 * body (everything after the signatures).
 *
 * @param vaaBytes The guardian-signed VAA.
 */
export function vaaHash(vaaBytes: Buffer): Hash {
  const signatures = vaaBytes.readUInt8(5);
  const body = vaaBytes.subarray(6 + signatures * SIGNATURE_LENGTH);
  return keccak256(keccak256(toHex(body)));
}

/**
 * The digest the destination manager marks executed: keccak256(uint16 source chain ‖ the encoded
 * manager message), as `TransceiverStructs.nttManagerMessageDigest` computes it. It is the same for
 * every signed copy of one transfer, where the VAA hash is not.
 *
 * @param sourceChain Wormhole chain id the transfer left from.
 * @param payload Raw transceiver payload bytes.
 */
export function managerDigest(sourceChain: number, payload: Buffer): Hash {
  const length = payload.readUInt16BE(MANAGER_MESSAGE_LENGTH_OFFSET);
  const message = payload.subarray(MANAGER_MESSAGE_OFFSET, MANAGER_MESSAGE_OFFSET + length);
  return keccak256(concat([toHex(sourceChain, { size: 2 }), toHex(message) as Hex]));
}

/**
 * The Wormhole chain a transfer is addressed to.
 *
 * @param payload Raw transceiver payload bytes of a transfer.
 */
export function targetChain(payload: Buffer): number {
  return payload.readUInt16BE(TO_CHAIN_OFFSET);
}

/**
 * An NTT `TrimmedAmount` in human units. It is a uint72 packing the amount (uint64) above its
 * decimals (uint8): `amount = raw >> 8`, `decimals = raw & 0xFF` (`TrimmedAmount.sol` getAmount /
 * getDecimals in native-token-transfers). The decimals are the trimmed precision — the token's own,
 * capped at 8 — so EURC (6) reads 908196247 at 6 as "908.196247".
 *
 * @param raw The packed value, as `getInboundQueuedTransfer` returns it.
 */
export function trimmedAmount(raw: bigint): string {
  return formatUnits(raw >> 8n, Number(raw & 0xffn));
}

/**
 * What one pass over a VAA did.
 *
 * - `ignored`: not a transfer for this route.
 * - `not-yet-due`: younger than the grace period; nothing read or sent. The caller throws so the
 *   engine comes back later.
 * - `delivered`: our transaction paid the recipient.
 * - `already-delivered`: Base had it before we sent anything.
 * - `completed-elsewhere`: the checks read open, then someone else's delivery landed first (our
 *   simulate refused, or our transaction reverted on the consumed VAA).
 * - `queued`: the Base manager accepted the transfer but holds it under its inbound rate limit; the
 *   recipient is not paid until someone calls `completeInboundQueuedTransfer` after the delay.
 */
export type Outcome =
  | "ignored"
  | "not-yet-due"
  | "already-delivered"
  | "delivered"
  | "completed-elsewhere"
  | "queued";

/**
 * This process's sends that have no known outcome yet: manager digest -> transaction hash. Written
 * when a send is broadcast, deleted once its receipt is read. In memory: a restart forgets it, and
 * the queue then starts from the chain's mined nonce, so a send still pending is competed with at
 * its own nonce, where only one of the two can mine.
 */
export type SentLedger = Map<Hash, Hash>;

export interface DeliverOptions {
  /** Act only on a VAA at least this old, measured from the VAA's own timestamp. */
  graceSeconds: number;
  /** Sends without a known outcome, shared by every pass of this process. */
  sent: SentLedger;
  /** Current time in unix seconds; injectable for the fork check. */
  now?: () => number;
  /** Alert sink for a queued transfer (Discord); optional. */
  alert?: (message: string) => Promise<void>;
}

/**
 * Post one line to a Discord webhook; failures are logged at error, never thrown. `fetch` resolves on
 * an HTTP error too, so a 4xx/5xx counts as a failure: its status and body are logged, together with
 * the line that was not delivered.
 */
export function discordAlert(webhook: string | undefined, log: typeof logger) {
  return async (message: string): Promise<void> => {
    if (!webhook) return;
    try {
      const res = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: message }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        log.error(
          `Discord notification failed: HTTP ${res.status} ${body.slice(0, 500)}; undelivered: ${message}`,
        );
      }
    } catch (e) {
      log.error(`Failed to send Discord notification: ${(e as Error).message}; undelivered: ${message}`);
    }
  };
}

/**
 * Deliver one Hydration -> Base NTT transfer, as a backstop.
 *
 * The user's own claim or the Wormhole Executor normally delivers within minutes, so nothing is read
 * or sent until the VAA is `graceSeconds` old (from the VAA timestamp, which the guardians sign: the
 * Hydration block time of the transfer). Then it reads both replay guards — the transceiver's
 * `isVAAConsumed(vaa hash)` and the manager's `isMessageExecuted(digest)`; the second also covers a
 * second signed copy of the same transfer, which carries another VAA hash — and, when either is set,
 * whether the manager holds the transfer in its inbound queue. Only when both read open does the
 * queue submit, and `submit` simulates before it spends a nonce.
 *
 * Never a blind retry: a throw hands the job back to the engine, and the retry starts again from
 * the reads, so a transaction that landed after all reads as done. A send whose receipt never came
 * (a receipt wait that timed out) stays in `opts.sent`, and the retry looks at that hash first: its
 * receipt, when there is one, is the outcome; while it is still known to a node the retry throws
 * and sends nothing; only once no node knows it (dropped) does the retry read and send again.
 *
 * The verdict after a receipt comes from the receipt: the manager's `InboundTransferQueued(digest)`
 * in its logs is `queued`, its `TransferRedeemed(digest)` is `delivered`, and a successful receipt
 * carrying neither throws (not proven). Every state read made after a receipt is pinned to the
 * receipt's block, so a node behind the one that served the receipt cannot answer with the state
 * before it; a node that cannot serve that block throws, for a retry. A send whose receipt is not
 * this delivery's own (a replacement) throws. A send that reverted is re-read at its block: a
 * consumed VAA means someone else's delivery landed first in the same block (gas spent, nothing
 * lost); anything else throws.
 *
 * @param route The outbound route the VAA arrived on.
 * @param vaa The parsed VAA.
 * @param clients Base account and clients.
 * @param queue This process's submission queue.
 * @param log Logger for this VAA.
 * @param opts Grace period, clock, alert sink.
 * @returns What the pass did.
 * @throws On anything unproven, for the engine to retry.
 */
export async function deliverOutbound(
  route: OutboundNttRoute,
  vaa: ParsedVaa,
  clients: ChainClients,
  queue: Queue,
  log: typeof logger,
  opts: DeliverOptions,
): Promise<Outcome> {
  if (!isNttTransfer(vaa.payload)) {
    log.info("Ignoring non-transfer NTT transceiver message");
    return "ignored";
  }
  if (!isForManager(vaa.payload, route.manager) || targetChain(vaa.payload) !== route.destinationChain) {
    log.info("Ignoring NTT transfer for another destination");
    return "ignored";
  }

  const now = (opts.now ?? (() => Math.floor(Date.now() / 1000)))();
  const age = now - vaa.timestamp;
  if (age < opts.graceSeconds) {
    log.debug(`${route.token} transfer is ${age} s old, under the ${opts.graceSeconds} s grace period`);
    return "not-yet-due";
  }

  const { publicClient } = clients;
  const hash = vaaHash(vaa.bytes);
  const digest = managerDigest(vaa.emitterChain, vaa.payload);

  /**
   * Done (and whether queued under the inbound limit), or still open.
   *
   * @param at Block to read at: a receipt's block after a send, so a lagging node cannot answer
   *   with the state before it; omitted (latest) before anything was sent.
   */
  async function state(at?: bigint): Promise<"open" | "done" | "queued"> {
    const [consumed, executed] = await Promise.all([
      publicClient.readContract({
        address: route.transceiver,
        abi: outboundAbi,
        functionName: "isVAAConsumed",
        args: [hash],
        blockNumber: at,
      }),
      publicClient.readContract({
        address: route.manager,
        abi: outboundAbi,
        functionName: "isMessageExecuted",
        args: [digest],
        blockNumber: at,
      }),
    ]);
    if (!consumed && !executed) return "open";
    return (await queuedReport(at)) ? "queued" : "done";
  }

  /**
   * The manager's inbound-queue entry for this transfer, as an alert line; undefined when none.
   *
   * @param at Block to read at, as for `state`.
   */
  async function queuedReport(at?: bigint): Promise<string | undefined> {
    const queued = await publicClient.readContract({
      address: route.manager,
      abi: outboundAbi,
      functionName: "getInboundQueuedTransfer",
      args: [digest],
      blockNumber: at,
    });
    if (queued.txTimestamp === 0n) return undefined;
    const delay = await publicClient.readContract({
      address: route.manager,
      abi: outboundAbi,
      functionName: "rateLimitDuration",
      blockNumber: at,
    });
    return (
      `ntt-base ${route.token} sequence ${vaa.sequence}: queued on Base under the inbound limit; someone must call ` +
      `completeInboundQueuedTransfer(${digest}) on ${route.manager} after the delay ` +
      `(completable from unix ${queued.txTimestamp + delay}; ${trimmedAmount(queued.amount)} ${route.token}, ` +
      `recipient ${queued.recipient})`
    );
  }

  /**
   * Log and alert a queued transfer. When it is known queued from a receipt's logs, the alert goes
   * out even if the entry's details cannot be read at that block: the line then says so.
   */
  async function reportQueued(at?: bigint): Promise<"queued"> {
    let line: string | undefined;
    let why = "no queue entry at that block";
    try {
      line = await queuedReport(at);
    } catch (e) {
      why = (e as Error).message.split("\n")[0];
    }
    line ??=
      `ntt-base ${route.token} sequence ${vaa.sequence}: queued on Base under the inbound limit; someone must call ` +
      `completeInboundQueuedTransfer(${digest}) on ${route.manager} after the delay (details unread: ${why})`;
    log.warn(line);
    await opts.alert?.(line);
    return "queued";
  }

  /** The manager's verdict on this transfer in `receipt`'s logs; undefined when it emitted neither. */
  function verdictFromLogs(receipt: TransactionReceipt): "queued" | "redeemed" | undefined {
    for (const entry of receipt.logs) {
      if (entry.address.toLowerCase() !== route.manager.toLowerCase()) continue;
      let event;
      try {
        event = decodeEventLog({ abi: outboundAbi, data: entry.data, topics: entry.topics });
      } catch {
        continue; // another of the manager's events
      }
      if (event.eventName === "InboundTransferQueued" && event.args.digest === digest) return "queued";
      if (event.eventName === "TransferRedeemed" && event.args.digest === digest) return "redeemed";
    }
    return undefined;
  }

  /** What a receipt for our own send `sentHash` says. Clears the send from the ledger. */
  async function settled(receipt: TransactionReceipt, sentHash: Hash): Promise<Outcome> {
    opts.sent.delete(digest);
    if (receipt.transactionHash.toLowerCase() !== sentHash.toLowerCase()) {
      throw new Error(`ntt-base ${route.token}: delivery ${sentHash} was replaced by ${receipt.transactionHash}`);
    }
    if (receipt.status !== "success") {
      const after = await state(receipt.blockNumber);
      if (after === "open") {
        throw new Error(`ntt-base ${route.token}: delivery ${sentHash} reverted on chain`);
      }
      log.info(`${route.token} transfer: lost the race, someone else's delivery landed first; ${sentHash} reverted (gas spent)`);
      return after === "queued" ? reportQueued(receipt.blockNumber) : "completed-elsewhere";
    }
    const verdict = verdictFromLogs(receipt);
    if (verdict === "queued") return reportQueued(receipt.blockNumber);
    if (verdict === "redeemed") return "delivered";
    throw new Error(
      `ntt-base ${route.token}: delivery ${sentHash} mined without the manager's InboundTransferQueued or ` +
        `TransferRedeemed for ${digest}; not proven delivered`,
    );
  }

  // An earlier send of this transfer whose receipt never came: settle it before anything else.
  const earlier = opts.sent.get(digest);
  if (earlier) {
    const receipt = await publicClient.getTransactionReceipt({ hash: earlier }).catch((e) => {
      if (e instanceof TransactionReceiptNotFoundError) return undefined;
      throw e;
    });
    if (receipt) return settled(receipt, earlier);
    const known = await publicClient.getTransaction({ hash: earlier }).catch((e) => {
      if (e instanceof TransactionNotFoundError) return undefined;
      throw e;
    });
    if (known) {
      throw new Error(`ntt-base ${route.token}: earlier delivery ${earlier} has no receipt yet; not sending again`);
    }
    log.warn(`${route.token} transfer: earlier delivery ${earlier} is unknown to the node (dropped); reading again`);
    opts.sent.delete(digest);
  }

  const before = await state();
  if (before === "queued") return reportQueued();
  if (before === "done") {
    log.info(`${route.token} transfer already delivered on Base`);
    return "already-delivered";
  }

  const sent: { hash?: Hash } = {};
  await queue.add({
    label: `${route.token} transfer to Base`,
    logger: log,
    submit: async (n) => {
      sent.hash = await receiveMessage(clients, outboundAbi, route.transceiver, vaa.bytes, n);
      opts.sent.set(digest, sent.hash);
      return sent.hash;
    },
  });

  if (!sent.hash) {
    // The queue resolved without sending: the simulate refused as done. Read what is now on Base.
    const after = await state();
    if (after === "queued") return reportQueued();
    if (after === "done") {
      log.info(`${route.token} transfer delivered by someone else first; nothing sent`);
      return "completed-elsewhere";
    }
    // Not proven either way (nothing in this app's ABI is classified dead): retry.
    throw new Error(`ntt-base ${route.token}: not sent and not delivered`);
  }

  // A throw here (a receipt wait that timed out) leaves the send in `opts.sent` for the retry.
  const receipt = await publicClient.waitForTransactionReceipt({ hash: sent.hash });
  return settled(receipt, sent.hash);
}

/**
 * One engine run over a VAA: `deliverOutbound`, with the two things only the job knows.
 *
 * - `not-yet-due` becomes a throw, so the engine comes back after its backoff (2, 4, 8, 16, 30 min).
 * - A throw on the last run is logged at error and alerted before it is rethrown: the engine gives
 *   up after it, and the VAA stays deliverable by hand. bullmq 3.16 counts `attemptsMade` from 1
 *   (it increments as the job becomes active), so the last run is the one where
 *   `attempts >= maxAttempts`.
 *
 * @param job The engine's attempt count for this run and the budget; absent when not run by the engine.
 * @returns The outcome of a run that ends the job.
 * @throws For the engine to retry, or after the last run to fail the job.
 */
export async function runOutbound(
  route: OutboundNttRoute,
  vaa: ParsedVaa,
  clients: ChainClients,
  queue: Queue,
  log: typeof logger,
  opts: DeliverOptions,
  job?: { attempts: number; maxAttempts: number },
): Promise<Outcome> {
  try {
    const outcome = await deliverOutbound(route, vaa, clients, queue, log, opts);
    if (outcome === "not-yet-due") {
      throw new Error(`ntt-base ${route.token} sequence ${vaa.sequence}: not yet due (grace ${opts.graceSeconds} s)`);
    }
    return outcome;
  } catch (e) {
    if (job !== undefined && job.attempts >= job.maxAttempts) {
      const line =
        `ntt-base ${route.token} sequence ${vaa.sequence}: gave up after ${job.maxAttempts} attempts; not ` +
        `confirmed delivered on Base (${(e as Error).message.split("\n")[0]}). Deliver it by hand with ` +
        `receiveMessage on ${route.transceiver}`;
      log.error(line);
      await opts.alert?.(line);
    }
    throw e;
  }
}
