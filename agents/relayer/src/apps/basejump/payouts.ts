import { formatUnits, parseAbi, zeroAddress, type Address, type Hash } from "viem";

import { submit, type ChainClients } from "../../clients/hydration";
import type { Queue } from "../../engine/queue";
import { revertName } from "../../engine/revert";
import logger from "../../logger";

/**
 * The landing's queue, and the one write this module ever makes: `fulfillPending()`. It takes no
 * arguments and is permissionless; the recipient and amount come from the landing's own storage,
 * so the caller cannot redirect a payout or change its size. It pays only the queue head.
 */
export const landingAbi = parseAbi([
  "function pendingHead() view returns (uint256)",
  "function pendingTail() view returns (uint256)",
  "function pendingTransfers(uint256 id) view returns (address sourceAsset, uint256 amount, bytes32 recipient)",
  "function destAssetFor(address sourceAsset) view returns (address)",
  "function fulfillPending() external",
  "error NoPendingTransfers()",
  "error InsufficientBalance()",
  "error DispatchFailed()",
]);

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
  /** Alert once when the same queued payout has been at the head for this long. */
  alertAfterMs: number;
  /** How long to wait for a sent call's receipt before leaving it to the next tick. */
  receiptTimeoutMs: number;
  /** Alert sink. Called at most once per queued payout, plus once when an alerted one is paid. */
  notify(message: string): Promise<void>;
  /** Clock, injectable for the fork probe. */
  now?: () => number;
}

/** What the keeper knows about the current head. Reset whenever the head moves. */
interface Head {
  id: bigint;
  /** When this process first saw it at the head. A restart resets it. */
  since: number;
  alerted: boolean;
  /** A `fulfillPending` this process sent while this entry was the head, not yet seen mined. */
  sent?: Hash;
  /** Calls for this head that simulated clean and then reverted on chain. */
  reverts: number;
}

/**
 * A call that simulates clean can still revert on chain (a direct payout spends the float in the
 * same block, say). That is worth a retry, but not an unbounded one: after this many, the keeper
 * stops sending for this head and alerts at once.
 */
export const MAX_REVERTS_PER_HEAD = 3;

/**
 * Pays queued Basejump payouts as soon as the landing can cover them.
 *
 * A payout queues when the landing's float is short; it is paid only when someone calls
 * `fulfillPending()` after the slower settlement leg refills the pool. This calls it: on every
 * tick it reads the head, the head entry and the pool's balance of that entry's asset, and calls
 * only when the pool covers the head and a simulation of the call passes.
 *
 * A head that does not become payable (the pool stays short, or the call reverts, e.g. a dispatch
 * that always fails) blocks everything behind it until the Technical Committee acts. The keeper
 * never retries such a head into a revert: it sends nothing and alerts once when the same head
 * has waited longer than `alertAfterMs`.
 *
 * An unobserved send is never repeated blindly. After a send for head `i`, nothing is sent again
 * until either the head moves past `i` or the call's receipt shows it reverted, and after
 * `MAX_REVERTS_PER_HEAD` such reverts nothing is sent for `i` at all. A call that is never mined
 * (dropped, or stuck behind a nonce gap) leaves the keeper checking its receipt and, after
 * `alertAfterMs`, alerting; it does not send a second one.
 *
 * @param deps Clients, the shared queue, the landing and the alert policy.
 * @returns `poke` to run one pass now, `start` to run passes on a timer.
 */
export function createPayoutKeeper(deps: PayoutKeeperDeps) {
  const { clients, queue, landing, alertAfterMs, receiptTimeoutMs, notify } = deps;
  const { publicClient, account } = clients;
  const now = deps.now ?? Date.now;
  const log = logger.child({ keeper: "basejump-queued-payouts", landing });

  let head: Head | undefined;
  let running: Promise<void> | undefined;
  let again = false;

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
    force = false,
  ): Promise<void> {
    const waited = now() - h.since;
    if (h.alerted || (!force && waited < alertAfterMs)) return;
    h.alerted = true;
    const msg =
      `WARN queued Basejump payout #${h.id} of ${what} waiting ` +
      `${Math.round(waited / 60_000)} min ` +
      `at the head of landing \`${landing}\`: ${reason}. Every later payout waits behind it.`;
    log.warn(msg);
    await notify(msg);
  }

  async function pass(): Promise<void> {
    const read = (functionName: "pendingHead" | "pendingTail") =>
      publicClient.readContract({ address: landing, abi: landingAbi, functionName });
    const [h, tail] = await Promise.all([read("pendingHead"), read("pendingTail")]);

    if (head && h > head.id) {
      log.info(`queued payout #${head.id} paid (head now ${h})`);
      if (head.alerted) await notify(`OK queued Basejump payout #${head.id} paid (head now ${h})`);
      head = undefined;
    }
    if (h >= tail) return;
    if (!head) {
      head = { id: h, since: now(), alerted: false, reverts: 0 };
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
      if (!receipt) {
        log.info(`#${h}: fulfillPending ${current.sent} not mined yet, checking`);
        await alertIfOverdue(current, what, `fulfillPending ${current.sent} sent, not seen mined`);
        return;
      }
      if (receipt.status === "success") return; // the head read raced the block; next pass sees it
      log.warn(`#${h}: fulfillPending ${current.sent} reverted on chain; nothing was paid`);
      current.sent = undefined;
      current.reverts++;
    }

    if (current.reverts >= MAX_REVERTS_PER_HEAD) {
      log.warn(`#${h}: ${current.reverts} calls reverted on chain; not sending again for it`);
      const reason = `${current.reverts} fulfillPending calls simulated clean, then reverted`;
      await alertIfOverdue(current, what, reason, true);
      return;
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
      return;
    }

    try {
      await publicClient.simulateContract({
        address: landing,
        abi: landingAbi,
        functionName: "fulfillPending",
        account,
      });
    } catch (e) {
      const name = revertName(e) ?? (e as Error).message;
      log.warn(`#${h}: fulfillPending would revert (${name}); not sending`);
      await alertIfOverdue(current, what, `fulfillPending reverts with ${name}`);
      return;
    }

    const sent: { hash?: Hash } = {};
    await queue.add({
      label: `basejump queued payout #${h}`,
      logger: log,
      submit: async (n) =>
        (sent.hash = await submit(
          clients,
          { to: landing, abi: landingAbi, functionName: "fulfillPending", args: [] },
          n,
        )),
    });
    if (!sent.hash) return;
    current.sent = sent.hash;

    const receipt = await publicClient
      .waitForTransactionReceipt({ hash: sent.hash, timeout: receiptTimeoutMs })
      .catch(() => undefined);
    if (!receipt) {
      log.info(`#${h}: fulfillPending ${sent.hash} sent, receipt not seen yet`);
      return;
    }
    // viem follows a replacement at the same nonce; only this call's own receipt counts.
    if (receipt.transactionHash.toLowerCase() !== sent.hash.toLowerCase()) {
      log.warn(`#${h}: fulfillPending ${sent.hash} was replaced by ${receipt.transactionHash}`);
      current.sent = undefined;
      return;
    }
    if (receipt.status === "success") {
      log.info(`#${h}: fulfillPending ${sent.hash} mined`);
    } else {
      log.warn(`#${h}: fulfillPending ${sent.hash} reverted on chain; nothing was paid`);
      current.sent = undefined;
      current.reverts++;
    }
  }

  async function describeOr(asset: Address, amount: bigint): Promise<string> {
    return asset === zeroAddress ? amount.toString() : describe(asset, amount);
  }

  /** Run passes until no poke arrived during the last one. Never throws. */
  async function loop(): Promise<void> {
    do {
      again = false;
      try {
        await pass();
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
