import {
  encodeAbiParameters,
  formatUnits,
  keccak256,
  parseAbi,
  toHex,
  zeroAddress,
  type Address,
  type Hash,
  type Hex,
} from "viem";

import { submit, type ChainClients } from "../../clients/hydration";
import type { Queue } from "../../engine/queue";
import { revertName } from "../../engine/revert";
import logger from "../../logger";

/**
 * The landing's queue, and the two writes this module ever makes: `fulfillPending()` and
 * `parkPending()`. Both take no arguments and are permissionless; the recipient and amount come
 * from the landing's own storage, so the caller cannot redirect a payout or change its size. Both
 * act on the queue head only. `parkPending` pays the head exactly as `fulfillPending` would when
 * its dispatch succeeds (with a fixed gas stipend), and otherwise moves it to `parkedTransfers`,
 * still reserved; it reverts `InsufficientBalance` on an unfunded head
 * (contracts/src/basejump/BasejumpLanding.sol, `parkPending`). `fulfillParked(id)` is never called
 * here: a parked payout needs a human.
 */
export const landingAbi = parseAbi([
  "function pendingHead() view returns (uint256)",
  "function pendingTail() view returns (uint256)",
  "function pendingTransfers(uint256 id) view returns (address sourceAsset, uint256 amount, bytes32 recipient)",
  "function destAssetFor(address sourceAsset) view returns (address)",
  "function fulfillPending() external",
  "function parkPending() external",
  "error NoPendingTransfers()",
  "error InsufficientBalance()",
  "error DispatchFailed()",
  "error InsufficientGas()",
]);

/** The landing writes this keeper sends. */
type Write = "fulfillPending" | "parkPending";

/**
 * Storage slot of the landing's `parkedTransfers` mapping (`mapping(uint256 => PendingTransfer)`).
 * `forge inspect BasejumpLanding storageLayout` puts it at slot 8, after `reservedFor` (6) and
 * `reservedAssetOf` (7), all appended below the pre-upgrade fields 0-5; the landing's UUPS rule is
 * append-only ("every field above keeps its slot"), and
 * `BasejumpLandingTest.testParkedEntryStorageLayoutForTheKeeper` pins this slot and the field order.
 */
export const PARKED_TRANSFERS_SLOT = 8n;

/**
 * The first of the three words entry `id` occupies in `parkedTransfers`: `keccak256(abi.encode(id,
 * 8))`. `PendingTransfer` is (address sourceAsset, uint256 amount, bytes32 recipient), one word
 * each (an address followed by a uint256 is not packed), at this slot + 0, + 1 and + 2.
 *
 * @param id The queue id.
 * @returns The slot of the entry's `sourceAsset` word.
 */
export function parkedEntrySlot(id: bigint): bigint {
  return BigInt(
    keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [id, PARKED_TRANSFERS_SLOT])),
  );
}

/** Most entries one pass reads back from `parkedTransfers`; a longer range continues on the next pass. */
export const PARK_SCAN_MAX_PER_PASS = 100;

const erc20Abi = parseAbi([
  "function balanceOf(address who) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

/** `BasejumpReceiver.landing()` — a bytes32 holding the landing's address in its low 20 bytes. */
const receiverAbi = parseAbi(["function landing() view returns (bytes32)"]);

export interface PayoutKeeperDeps {
  clients: ChainClients;
  /** The app's submission queue. Sharing it keeps these calls on the app wallet's nonce lane. */
  queue: Queue;
  landing: Address;
  /**
   * The `waiting` head alert's threshold (time at the head) and the backlog alert's first
   * threshold (oldest first-seen age). The README's alert table lists each alert's rule.
   */
  alertAfterMs: number;
  /** Most payouts one run sends before leaving the rest to the next poll. Default 10. */
  maxPerRun?: number;
  /** How long to wait for a sent call's receipt before leaving it to the next tick. */
  receiptTimeoutMs: number;
  /** Alert sink for every WARN and OK message (rules in the README's alert table). */
  notify(message: string): Promise<void>;
  /** Clock, injectable for the fork probe. */
  now?: () => number;
}

/**
 * Why a head gets an alert. `waiting`: `now - Head.since >= alertAfterMs` while the pool is short,
 * the simulation reverts, or a sent call has no receipt. `reverting`: `Head.reverts` reached
 * `MAX_REVERTS_PER_HEAD`; no clock. Each cause is recorded in `Head.alerted` and posts only when
 * absent from it.
 */
type Cause = "waiting" | "reverting";

/** What the keeper knows about the current head. Reset whenever the head moves. */
interface Head {
  id: bigint;
  /** When this process first saw it at the head. A restart resets it. */
  since: number;
  /** Causes already alerted for this head. */
  alerted: Set<Cause>;
  /** A call this process sent while this entry was the head, not yet seen mined. */
  sent?: Hash;
  /** Which call `sent` is. */
  sentFn?: Write;
  /** Calls for this head that simulated clean and then reverted on chain, in this window. */
  reverts: number;
  /** When `reverts` reached the cap. The count resets one pause later. */
  cappedAt?: number;
  /** How many times this head has hit the cap; each pause is twice the last, up to 6 h. */
  caps: number;
}

/**
 * A call that simulates clean can still revert on chain: the simulation runs on the latest block,
 * and a delivery this app sent just before can spend the float in the next one. That is worth a
 * retry, but not an unbounded one: after this many, the keeper stops sending for this head and
 * alerts at once, then pauses: `alertAfterMs`, doubling each time the cap is hit again for the
 * same head, up to `MAX_REVERT_PAUSE_MS`. The count, the pause and the cap counter are fields of
 * `Head`, in process memory.
 */
export const MAX_REVERTS_PER_HEAD = 3;

/** The longest pause after the cap. */
export const MAX_REVERT_PAUSE_MS = 6 * 60 * 60_000;

/**
 * Pays queued Basejump payouts as soon as the landing can cover them.
 *
 * A payout queues when the landing's float is short; it is paid only when someone calls
 * `fulfillPending()` after the slower settlement leg refills the pool. This calls it: on every
 * tick it reads the head, the head entry and the pool's balance of that entry's asset, and calls
 * only when the pool covers the head and a simulation of the call passes.
 *
 * A funded head whose `fulfillPending` simulation reverts `DispatchFailed` (the runtime refuses the
 * transfer itself, e.g. an amount below the existential deposit to an empty account) is parked
 * instead: the keeper simulates and sends `parkPending()`, which pays the head if its dispatch
 * succeeds by then and otherwise moves it to `parkedTransfers`, so the entries behind it are paid.
 * A park ends the round. The keeper never parks an unfunded head (it checks the pool first, and the
 * landing refuses one), and never calls `fulfillParked`. A head that does not become payable for
 * any other reason (the pool stays short, another revert, or `parkPending` itself reverts, as on a
 * landing without it) blocks everything behind it until it is paid or the Technical Committee
 * acts (`withdraw` or an upgrade); the keeper sends nothing for it.
 *
 * Every entry below the head, from id 0 in each process, is read back from `parkedTransfers` at
 * one block whose `pendingHead` is past it, straight from the landing's storage (slot 8), so the
 * answer does not depend on which implementation is live; one found there is alerted once per
 * process (the README's alert table, "parked"). A failed read is never taken as paid.
 *
 * Within one process, an unobserved send is never repeated blindly: after a send for head `i`
 * (recorded in `Head.sent`, in process memory), nothing is sent again until either the head moves
 * past `i` or the call's receipt shows it reverted, and after `MAX_REVERTS_PER_HEAD` such reverts
 * nothing is sent for `i` for a growing pause. A call that is never mined (dropped, or stuck
 * behind a nonce gap) leaves this process checking its receipt; it does not send a second one.
 *
 * @param deps Clients, the shared queue, the landing and the alert policy.
 * @returns `poke` to run one pass now, `start` to run passes on a timer.
 */
export function createPayoutKeeper(deps: PayoutKeeperDeps) {
  const { clients, queue, landing, alertAfterMs, receiptTimeoutMs, notify } = deps;
  const maxPerRun = deps.maxPerRun ?? 10;
  const { publicClient, account } = clients;
  const now = deps.now ?? Date.now;
  const log = logger.child({ keeper: "basejump-queued-payouts", landing });

  let head: Head | undefined;
  /**
   * When this process first saw each queued id (stamped after a successful head/tail read), for the
   * backlog age. The landing stores no enqueue time (`PendingTransfer` is asset, amount,
   * recipient). In process memory. Ids below the head are dropped.
   */
  const firstSeen = new Map<bigint, number>();
  let nextUnseen = 0n;
  /**
   * Undefined when no backlog alert is out. Otherwise the oldest age of the next backlog post: the
   * smallest `alertAfterMs * 2^k` (k >= 1) above the age at the last post. Reset to undefined, with
   * an OK message, when the queue is empty or the oldest age is below `alertAfterMs / 2`.
   */
  let backlogNextMs: number | undefined;
  let running: Promise<void> | undefined;
  let again = false;
  /**
   * The lowest id not yet read back from `parkedTransfers`. Starts at 0 in every process, so a
   * restarted process reads (and alerts) every entry still parked.
   */
  let scanFrom = 0n;
  /** Ids found parked (and alerted) by this process. */
  const parked = new Set<bigint>();

  const assets = new Map<Address, { symbol: string; decimals: number | undefined }>();

  /** "5.000000 USDC (asset 21)", falling back to raw units when the token will not say. */
  async function describe(asset: Address, amount: bigint): Promise<string> {
    let meta = assets.get(asset);
    if (!meta) {
      const id = Number(BigInt(asset) & 0xffffffffn);
      const [symbol, decimals] = await Promise.all([
        publicClient
          .readContract({ address: asset, abi: erc20Abi, functionName: "symbol" })
          .catch(() => undefined),
        publicClient
          .readContract({ address: asset, abi: erc20Abi, functionName: "decimals" })
          .catch(() => undefined),
      ]);
      meta = { symbol: `${symbol ?? "units"} (asset ${id})`, decimals };
      assets.set(asset, meta);
    }
    const value =
      meta.decimals === undefined ? amount.toString() : formatUnits(amount, meta.decimals);
    return `${value} ${meta.symbol}`;
  }

  async function alertIfOverdue(
    h: Head,
    what: string,
    reason: string,
    cause: Cause = "waiting",
  ): Promise<void> {
    const waited = now() - h.since;
    if (h.alerted.has(cause) || (cause === "waiting" && waited < alertAfterMs)) return;
    h.alerted.add(cause);
    const msg =
      `WARN queued Basejump payout #${h.id} of ${what} head-blocking for ` +
      `${Math.round(waited / 60_000)} min ` +
      `at the head of landing \`${landing}\`: ${reason}. Every later payout waits behind it.`;
    log.warn(msg);
    await notify(msg);
  }

  /**
   * Backlog alert on the oldest entry's first-seen age (it includes time behind earlier entries).
   * Posts when the age is at least `backlogNextMs ?? alertAfterMs` and the head has no head alert
   * out; posts OK and resets when the queue is empty or the age is below `alertAfterMs / 2`.
   */
  async function backlogCheck(h: bigint, tail: bigint): Promise<void> {
    if (h >= tail) {
      await clearBacklog(`queue empty`);
      return;
    }
    const age = now() - (firstSeen.get(h) ?? now());
    if (age < alertAfterMs / 2) {
      await clearBacklog(`oldest payout #${h} is ${Math.round(age / 60_000)} min old`);
      return;
    }
    if (age < (backlogNextMs ?? alertAfterMs)) return;
    if (head && head.id === h && head.alerted.size > 0) return;
    let next = 2 * (backlogNextMs ?? alertAfterMs);
    while (next > 0 && next <= age) next *= 2; // one post per jump, however many doublings it skipped
    backlogNextMs = next;
    const msg =
      `WARN queued Basejump backlog on landing \`${landing}\`: oldest payout #${h} queued ` +
      `${Math.round(age / 60_000)} min since this keeper process first saw it, ${tail - h} queued, ` +
      `next re-alert age ${Math.round(backlogNextMs / 60_000)} min.`;
    log.warn(msg);
    await notify(msg);
  }

  async function clearBacklog(why: string): Promise<void> {
    if (backlogNextMs === undefined) return;
    backlogNextMs = undefined;
    log.info(`queued backlog cleared (${why})`);
    await notify(`OK queued Basejump backlog on landing \`${landing}\` cleared (${why})`);
  }

  /**
   * The park alert: once per id per process, measurements only.
   *
   * @param id The parked entry.
   * @param entry `parkedTransfers(id)` as read from storage.
   * @param headAt `pendingHead` at the block `entry` was read at, when read.
   * @param detail Extra measurements (this keeper's own call and the pool it saw), or "".
   */
  async function alertParked(
    id: bigint,
    entry: readonly [Address, bigint, `0x${string}`],
    headAt: bigint | undefined,
    detail: string,
  ): Promise<void> {
    if (parked.has(id)) return;
    parked.add(id);
    const [sourceAsset, amount, recipient] = entry;
    const destAsset = await publicClient
      .readContract({ address: landing, abi: landingAbi, functionName: "destAssetFor", args: [sourceAsset] })
      .catch(() => zeroAddress);
    const what =
      destAsset === zeroAddress ? `${amount} units of ${sourceAsset}` : await describe(destAsset, amount);
    const msg =
      `WARN queued Basejump payout #${id} of ${what} parked on landing \`${landing}\`: ` +
      `parkedTransfers(${id}) holds it, recipient ${recipient}${detail}` +
      `${headAt === undefined ? "" : `; head then ${headAt}`}.`;
    log.warn(msg);
    await notify(msg);
  }

  /**
   * Entry `id` of `parkedTransfers`, read from the landing's storage at `blockNumber`: the three
   * words at `parkedEntrySlot(id)` + 0, + 1, + 2 (`eth_getStorageAt`), not through the getter, so
   * the answer does not depend on which implementation the proxy points at. A landing rolled back to
   * an implementation without `parkedTransfers` still holds an entry parked before the rollback in
   * slot 8, and this reads it. Every word must come back as a hex word; any failed or malformed
   * read throws, and the caller counts the entry as not read.
   *
   * Empty means all three words are zero, which is what `delete parkedTransfers[id]` leaves and what
   * a never-parked id holds. Any non-zero word means held. No single field is used as the marker:
   * the landing itself checks none of them for zero at enqueue (`transfer` accepts any amount and
   * recipient, and `setDestAsset` accepts source asset 0), so each can be zero in a real entry.
   *
   * @param id The queue id.
   * @param blockNumber The block to read at.
   * @returns The entry, or undefined when the slot is empty.
   */
  async function readParked(
    id: bigint,
    blockNumber: bigint,
  ): Promise<readonly [Address, bigint, Hex] | undefined> {
    const base = parkedEntrySlot(id);
    const words = await Promise.all(
      [0n, 1n, 2n].map(async (k) => {
        const word = await publicClient.getStorageAt({ address: landing, slot: toHex(base + k, { size: 32 }), blockNumber });
        if (typeof word !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(word)) {
          throw new Error(`parkedTransfers(${id}) word ${k} read as ${String(word)}`);
        }
        return BigInt(word);
      }),
    );
    if (words.every((w) => w === 0n)) return undefined;
    const [src, amount, recipient] = words;
    return [
      toHex(src & ((1n << 160n) - 1n), { size: 20 }) as Address,
      amount,
      toHex(recipient, { size: 32 }),
    ] as const;
  }

  /**
   * Reads back every entry below the head, from id 0 in each process, at one block: ids below
   * that block's `pendingHead` are past the head there, so an empty `parkedTransfers` slot means
   * paid (`fulfillPending`, `parkPending` or, after a park, `fulfillParked`) and a held one means
   * parked. The slot is read from storage (`readParked`), on every implementation: a landing that
   * never had parking holds nothing there, and one rolled back after a park still holds the entry.
   * Any failed read (the block, the head, or a word of an entry) stops the scan; it resumes at the
   * same id on the next pass, and that id counts as not read. Never throws.
   *
   * Bound: "empty means paid" holds while slot 8 is `parkedTransfers` and only a payment clears it,
   * as in every implementation so far (the pre-upgrade one never writes slot 8). An implementation
   * that moved the mapping, or cleared an entry without paying it, would read as paid here.
   *
   * @param h The `pendingHead` this pass read.
   */
  async function scanParked(h: bigint): Promise<void> {
    if (scanFrom >= h) return;
    try {
      const blockNumber = await publicClient.getBlockNumber();
      const headAt = await publicClient.readContract({
        address: landing,
        abi: landingAbi,
        functionName: "pendingHead",
        blockNumber,
      });
      for (let n = 0; scanFrom < headAt && n < PARK_SCAN_MAX_PER_PASS; scanFrom++, n++) {
        const entry = await readParked(scanFrom, blockNumber);
        if (entry) await alertParked(scanFrom, entry, headAt, "");
      }
    } catch (e) {
      log.warn(`parked check from #${scanFrom} failed: ${(e as Error).message ?? String(e)}`);
    }
  }

  /** One pass: read the queue, then pay the head when the pool covers it. */
  async function pass(): Promise<boolean> {
    const read = (functionName: "pendingHead" | "pendingTail") =>
      publicClient.readContract({ address: landing, abi: landingAbi, functionName });
    const [h, tail] = await Promise.all([read("pendingHead"), read("pendingTail")]);
    if (nextUnseen < h) nextUnseen = h;
    for (; nextUnseen < tail; nextUnseen++) firstSeen.set(nextUnseen, now());
    for (const id of firstSeen.keys()) if (id < h) firstSeen.delete(id);
    await scanParked(h);
    try {
      return await payHead(h, tail);
    } finally {
      await backlogCheck(h, tail).catch((e) =>
        log.warn(`backlog check failed: ${(e as Error).message ?? String(e)}`),
      );
    }
  }

  /**
   * Pays the head if it can, or parks it (see above). Resolves true only when this call saw its own
   * `fulfillPending` mined and succeeded; a park, or a `parkPending` that paid, resolves false.
   */
  async function payHead(h: bigint, tail: bigint): Promise<boolean> {

    if (head && h > head.id) {
      const id = head.id;
      if (parked.has(id)) {
        log.info(`queued payout #${id} parked (head now ${h})`); // the park alert was posted
      } else if (scanFrom > id) {
        log.info(`queued payout #${id} paid (head now ${h})`);
        if (head.alerted.size > 0) await notify(`OK queued Basejump payout #${id} paid (head now ${h})`);
      } else {
        log.info(`queued payout #${id} left the head (head now ${h}); parked state not read`);
        if (head.alerted.size > 0) {
          await notify(
            `OK queued Basejump payout #${id} left the head (head now ${h}); ` +
              `parkedTransfers(${id}) not read`,
          );
        }
      }
      head = undefined;
    }
    if (h >= tail) return false;
    if (!head) {
      head = { id: h, since: now(), alerted: new Set(), reverts: 0, caps: 0 };
      log.info(`queued payout #${h} at the head (${tail - h} queued)`);
    }
    const current = head;

    const [sourceAsset, amount] = await publicClient.readContract({
      address: landing,
      abi: landingAbi,
      functionName: "pendingTransfers",
      args: [h],
    });
    const destAsset = await publicClient.readContract({
      address: landing,
      abi: landingAbi,
      functionName: "destAssetFor",
      args: [sourceAsset],
    });
    const what =
      destAsset === zeroAddress
        ? `${amount} units of unmapped ${sourceAsset}`
        : await describe(destAsset, amount);

    // A call this process sent for this same head and has not seen mined. Re-sending it unobserved
    // could pay the NEXT entry by accident of timing, so wait for the receipt instead.
    if (current.sent) {
      const receipt = await publicClient
        .getTransactionReceipt({ hash: current.sent })
        .catch(() => undefined);
      const fn = current.sentFn ?? "fulfillPending";
      if (!receipt) {
        log.info(`#${h}: ${fn} ${current.sent} not mined yet, checking`);
        await alertIfOverdue(
          current,
          what,
          `${fn} ${current.sent} sent, not seen mined. If it was dropped, every later ` +
            `send of this app, deliveries included, waits behind its nonce`,
        );
        return false;
      }
      if (receipt.status === "success") return false; // the head read raced the block; next pass sees it
      log.warn(`#${h}: ${fn} ${current.sent} reverted on chain; nothing was paid or parked`);
      current.sent = undefined;
      current.reverts++;
    }

    if (current.reverts >= MAX_REVERTS_PER_HEAD) {
      if (current.cappedAt === undefined) {
        current.cappedAt = now();
        current.caps++;
      }
      // 30 min, 1 h, 2 h, 4 h, then 6 h each time (with the default alert interval).
      const pause = Math.max(
        alertAfterMs,
        Math.min(alertAfterMs * 2 ** (current.caps - 1), MAX_REVERT_PAUSE_MS),
      );
      if (now() - current.cappedAt < pause) {
        log.warn(
          `#${h}: ${current.reverts} calls reverted on chain; ` +
            `paused ${Math.round(pause / 60_000)} min`,
        );
        const reason = `${current.reverts} ${current.sentFn ?? "fulfillPending"} calls simulated clean, then reverted`;
        await alertIfOverdue(current, what, reason, "reverting");
        return false;
      }
      log.info(`#${h}: revert cap expired; trying again`);
      current.reverts = 0;
      current.cappedAt = undefined;
    }

    const balance =
      destAsset === zeroAddress
        ? 0n
        : await publicClient.readContract({
            address: destAsset,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [landing],
          });
    if (balance < amount) {
      log.info(`#${h}: waiting for the pool (holds ${balance}, needs ${amount})`);
      await alertIfOverdue(current, what, `the pool holds ${await describeOr(destAsset, balance)}`);
      return false;
    }

    let fn: Write = "fulfillPending";
    try {
      await publicClient.simulateContract({
        address: landing,
        abi: landingAbi,
        functionName: "fulfillPending",
        account,
      });
    } catch (e) {
      const name = revertName(e) ?? (e as Error).message;
      if (name !== "DispatchFailed") {
        log.warn(`#${h}: fulfillPending would revert (${name}); not sending`);
        await alertIfOverdue(current, what, `fulfillPending reverts with ${name}`);
        return false;
      }
      // Funded (checked above), and the runtime refuses the transfer itself: park it, so the
      // entries behind it are paid. parkPending pays it instead if the dispatch succeeds by then.
      try {
        await publicClient.simulateContract({
          address: landing,
          abi: landingAbi,
          functionName: "parkPending",
          account,
        });
      } catch (e2) {
        const name2 = revertName(e2) ?? (e2 as Error).message;
        log.warn(`#${h}: fulfillPending reverts DispatchFailed, parkPending would revert (${name2}); not sending`);
        await alertIfOverdue(
          current,
          what,
          `fulfillPending reverts with DispatchFailed, parkPending reverts with ${name2}`,
        );
        return false;
      }
      fn = "parkPending";
    }

    const sent: { hash?: Hash } = {};
    await queue.add({
      label: `basejump queued payout #${h} (${fn})`,
      logger: log,
      // `current.sent` is set here, the moment the send returns a hash, so it survives a queue whose
      // `add` rejects after the transaction went out.
      submit: async (n) => {
        sent.hash = await submit(
          clients,
          { to: landing, abi: landingAbi, functionName: fn, args: [] },
          n,
        );
        current.sent = sent.hash;
        current.sentFn = fn;
        return sent.hash;
      },
    });
    if (!sent.hash) return false;

    const receipt = await publicClient
      .waitForTransactionReceipt({ hash: sent.hash, timeout: receiptTimeoutMs })
      .catch(() => undefined);
    if (!receipt) {
      log.info(`#${h}: ${fn} ${sent.hash} sent, receipt not seen yet`);
      return false;
    }
    // viem follows a replacement at the same nonce; only this call's own receipt counts.
    if (receipt.transactionHash.toLowerCase() !== sent.hash.toLowerCase()) {
      log.warn(`#${h}: ${fn} ${sent.hash} was replaced by ${receipt.transactionHash}`);
      current.sent = undefined;
      return false;
    }
    if (receipt.status !== "success") {
      log.warn(`#${h}: ${fn} ${sent.hash} reverted on chain; nothing was paid or parked`);
      current.sent = undefined;
      current.reverts++;
      return false;
    }
    log.info(`#${h}: ${fn} ${sent.hash} mined`);
    if (fn === "fulfillPending") return true;

    // parkPending succeeded: it either paid the head or parked it. Read which at its own block.
    // A failed read decides nothing here; the scan reads the id again below a later head.
    const read = await readParked(h, receipt.blockNumber).then(
      (entry) => ({ entry }),
      () => undefined,
    );
    if (read?.entry) {
      await alertParked(
        h,
        read.entry,
        undefined,
        `, by this keeper's parkPending ${sent.hash} with the pool holding ${await describeOr(destAsset, balance)}`,
      );
    } else if (read) {
      log.info(`#${h}: parkPending ${sent.hash} paid it`);
    }
    // A park ends the round; the next pass pays the new head.
    return false;
  }

  async function describeOr(asset: Address, amount: bigint): Promise<string> {
    return asset === zeroAddress ? amount.toString() : describe(asset, amount);
  }

  /**
   * Run passes until no poke arrived during the last one. Within a round, a pass that saw its own
   * `fulfillPending` mined and successful is followed by another for the new head, up to
   * `maxPerRun` payouts; any other outcome (nothing queued, pool short, revert, no receipt,
   * replaced, a stale head read, a `parkPending` sent) ends the round exactly as a single pass always did. Never throws.
   */
  async function loop(): Promise<void> {
    do {
      again = false;
      try {
        for (let paid = 0; paid < maxPerRun; paid++) {
          if (!(await pass())) break;
          if (paid + 1 === maxPerRun) {
            log.info(`${maxPerRun} payouts sent this run; the rest waits for the next poll`);
          }
        }
      } catch (e) {
        log.warn(`queued payout pass failed: ${(e as Error).message ?? String(e)}`);
      }
    } while (again);
  }

  /**
   * Run one pass now, or one more after the current one ends. Passes never overlap.
   *
   * @returns Resolves when the passes in flight are done.
   */
  function poke(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = loop().finally(() => {
      running = undefined;
    });
    return running;
  }

  /**
   * Run a pass every `intervalMs`. An empty queue costs two reads per pass.
   *
   * @returns A function that stops the timer.
   */
  function start(intervalMs: number): () => void {
    const timer = setInterval(() => void poke(), intervalMs);
    return () => clearInterval(timer);
  }

  return { poke, start };
}

export type PayoutKeeper = ReturnType<typeof createPayoutKeeper>;

/**
 * The landings behind the given receivers, deduplicated. Read from each receiver rather than
 * configured, so the keeper always watches the pool the receivers actually pay out of.
 *
 * @param clients Hydration clients.
 * @param receivers Deployed BasejumpReceiver proxies.
 * @returns Each distinct non-zero landing.
 */
export async function landingsOf(clients: ChainClients, receivers: Address[]): Promise<Address[]> {
  const found = new Set<Address>();
  for (const receiver of receivers) {
    const word = await clients.publicClient.readContract({
      address: receiver,
      abi: receiverAbi,
      functionName: "landing",
    });
    const addr = `0x${word.slice(-40)}`.toLowerCase() as Address;
    if (addr === zeroAddress) {
      logger.warn(`  receiver ${receiver} has no landing set; nothing to watch for it`);
      continue;
    }
    found.add(addr);
  }
  return [...found];
}

/**
 * A Discord webhook sink, logging only when no webhook is set.
 *
 * @param webhook The webhook URL, or undefined.
 * @returns A sender that never throws.
 */
export function discordNotifier(webhook: string | undefined): (message: string) => Promise<void> {
  return async (message: string) => {
    if (!webhook) return;
    try {
      const res = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: message }),
      });
      if (!res.ok) logger.error(`Discord notification failed: HTTP ${res.status}`);
    } catch (e) {
      logger.error(`Failed to send Discord notification: ${(e as Error).message}`);
    }
  };
}
