import type { Address, Chain, PublicClient, Transport } from "viem";

import { erc20Abi, facilitatorKeeperAbi, ghoAbi, vaultKeeperAbi, wormholeCoreAbi } from "../abi";
import {
  BOOKS_STALL_MS,
  LIQUIDITY_STALL_MS,
  LOG_CHUNK_BLOCKS,
  LOG_CONFIRMATIONS,
  LOG_LOOKBACK_BLOCKS,
  LOG_OVERLAP_BLOCKS,
  RESERVE_TOLERANCE,
} from "../config";
import { usdc, type KeeperCtx } from "./common";

/** Consecutive failed log reads before the watcher reports itself blind. */
const LOG_FAILURES_ALERT = 5;
/** Log chunks read per tick, so a long backlog is worked off over several ticks. */
const LOG_CHUNKS_PER_TICK = 10;

const VAULT_EVENTS = vaultKeeperAbi.filter(
  (item) => item.type === "event" && (item.name === "Disputed" || item.name === "CreditUnpayable"),
);

type Reader = PublicClient<Transport, Chain>;

/** Raise an alert when a boolean flips; the first read only records it. */
function flag(ctx: KeeperCtx, seen: Map<string, boolean>, name: string, value: boolean): void {
  const prev = seen.get(name);
  seen.set(name, value);
  if (prev !== undefined && prev !== value) {
    ctx.alerter.alert(`psm:flag:${name}`, String(value), `psm: ${name} is now ${value}`);
  }
}

/**
 * Run each check on its own, so one failing read does not blind the rest. The names of the checks
 * that failed go to `failed`; the first error is rethrown for the loop to log.
 */
async function checks(
  label: string,
  ctx: KeeperCtx,
  list: [string, () => Promise<void>][],
  failed: string[],
): Promise<void> {
  let first: unknown;
  failed.length = 0;
  for (const [name, check] of list) {
    try {
      await check();
    } catch (e) {
      ctx.log.warn(`${label} ${name} check failed: ${(e as Error)?.message ?? String(e)}`);
      failed.push(name);
      first ??= e;
    }
  }
  if (first !== undefined) throw first;
}

// ─── Base ─────────────────────────────────────────────────────────

export interface BaseWatch {
  vault: Address;
  /** Hydration side of the books check: a keyless reader and the facilitator. */
  books?: { reader: () => Promise<Reader>; facilitator: Address };
  flags: Map<string, boolean>;
  reserveStrikes: number;
  booksStrikes: number;
  /** USDC in flight between the chains, and since when it last fell. */
  inFlight?: { amount: bigint; since: number };
  logCursor?: bigint;
  logFailures: number;
  /** Checks that failed on the last tick. */
  failed: string[];
  addresses?: { usdc: Address; aUsdc: Address; core: Address };
  scale?: bigint;
}

export function baseWatch(vault: Address, books?: BaseWatch["books"]): BaseWatch {
  return { vault, books, flags: new Map(), reserveStrikes: 0, booksStrikes: 0, logFailures: 0, failed: [] };
}

/**
 * The vault's alerts: pause flags, the Wormhole message fee, the reserve against what it owes, the
 * books against the facilitator, and `Disputed` and `CreditUnpayable` logs.
 */
export async function baseWatchTick(ctx: KeeperCtx, w: BaseWatch): Promise<void> {
  const client = ctx.clients.publicClient;
  const vault = <T>(functionName: string, args: readonly unknown[] = []): Promise<T> =>
    client.readContract({ address: w.vault, abi: vaultKeeperAbi, functionName, args } as never) as never;

  w.addresses ??= {
    usdc: await vault<Address>("usdc"),
    aUsdc: await vault<Address>("aUsdc"),
    core: await vault<Address>("wormhole"),
  };
  const { usdc: usdcToken, aUsdc, core } = w.addresses;

  await checks("psm vault watch", ctx, [
    [
      "pauses",
      async () => {
        for (const name of ["depositsPaused", "claimsPaused", "investPaused"]) {
          flag(ctx, w.flags, `vault.${name}`, await vault<boolean>(name));
        }
      },
    ],
    [
      "message fee",
      async () => {
        // A fee-cap return publishes from inside the non-payable delivery, so any fee reverts it.
        const fee = (await client.readContract({ address: core, abi: wormholeCoreAbi, functionName: "messageFee" })) as bigint;
        if (fee > 0n) {
          ctx.alerter.alert(
            "psm:message-fee",
            fee.toString(),
            `psm: the Base Wormhole message fee is ${fee}; every fee-cap return reverts until it is 0`,
          );
        } else ctx.alerter.clear("psm:message-fee");
      },
    ],
    [
      "reserve",
      async () => {
        // Every read at one block: a deposit or payout landing between two reads would show a
        // shortfall that never existed. Two in a row before alerting, for a reorg under that block.
        const blockNumber = await client.getBlockNumber();
        const balance = (token: Address) =>
          client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [w.vault], blockNumber }) as Promise<bigint>;
        const owes = (functionName: string) =>
          client.readContract({ address: w.vault, abi: vaultKeeperAbi, functionName, blockNumber } as never) as Promise<bigint>;
        const [idle, supplied, principal, owed, unpayable] = await Promise.all([
          balance(usdcToken),
          balance(aUsdc),
          owes("principal"),
          owes("totalOwed"),
          owes("totalUnpayable"),
        ]);
        const assets = idle + supplied;
        const liabilities = principal + owed + unpayable;
        if (assets + RESERVE_TOLERANCE < liabilities) {
          w.reserveStrikes += 1;
          if (w.reserveStrikes >= 2) {
            ctx.alerter.alert(
              "psm:reserve-short",
              "short",
              `psm vault: reserve ${usdc(assets)} is ${usdc(liabilities - assets)} short of what it owes ${usdc(liabilities)}`,
            );
          }
        } else {
          w.reserveStrikes = 0;
          ctx.alerter.clear("psm:reserve-short");
        }
      },
    ],
    [
      "books",
      async () => {
        if (!w.books) return;
        const reader = await w.books.reader();
        const facilitator = <T>(functionName: string): Promise<T> =>
          reader.readContract({ address: w.books!.facilitator, abi: facilitatorKeeperAbi, functionName } as never) as never;
        w.scale ??= await facilitator<bigint>("scale");
        // Hydration first, then Base: every leg raises Base principal before Hydration and lowers
        // Hydration before Base, so a message in flight only ever leaves principal above.
        const [outstanding, pending] = await Promise.all([facilitator<bigint>("outstanding"), facilitator<bigint>("totalPendingMint")]);
        const principal = await vault<bigint>("principal");
        const backed = outstanding / w.scale + pending;
        if (principal < backed) {
          w.booksStrikes += 1;
          if (w.booksStrikes >= 2) {
            ctx.alerter.alert(
              "psm:books",
              "short",
              `psm books: Base principal ${usdc(principal)} is below Hydration's minted ${usdc(outstanding / w.scale)} ` +
                `plus queued ${usdc(pending)}: HOLLAR exists with no USDC behind it`,
            );
          }
        } else {
          w.booksStrikes = 0;
          ctx.alerter.clear("psm:books");
        }
        stalled(ctx, w, principal > backed ? principal - backed : 0n);
      },
    ],
    ["logs", () => vaultLogs(ctx, w)],
  ], w.failed);
}

/**
 * Principal above what Hydration holds is USDC in flight: a deposit or a cancel booked on Base and
 * not yet minted, a burn on Hydration not yet credited. Every delivery lowers it, so an amount that
 * has not fallen in `BOOKS_STALL_MS` is a corridor that stopped delivering, or a `Disputed` message
 * that never will. A delivery landing between the two chains' reads can show as a one-tick dip,
 * which only restarts the clock.
 */
function stalled(ctx: KeeperCtx, w: BaseWatch, amount: bigint): void {
  const now = ctx.now();
  if (amount === 0n || !w.inFlight || amount < w.inFlight.amount) {
    w.inFlight = amount === 0n ? undefined : { amount, since: now };
    ctx.alerter.clear("psm:books-stalled");
    return;
  }
  w.inFlight.amount = amount;
  const waited = now - w.inFlight.since;
  if (waited >= BOOKS_STALL_MS) {
    ctx.alerter.alert(
      "psm:books-stalled",
      "stalled",
      `psm books: ${usdc(amount)} has been in flight between the chains for ${Math.round(waited / 60_000)} min ` +
        `with no delivery landing: a relayer, its Redis or the spy is down, or a Disputed message stranded it`,
    );
  }
}

async function vaultLogs(ctx: KeeperCtx, w: BaseWatch): Promise<void> {
  const client = ctx.clients.publicClient;
  try {
    const head = await client.getBlockNumber();
    const to = head > LOG_CONFIRMATIONS ? head - LOG_CONFIRMATIONS : 0n;
    // Each pass starts a little behind where the last ended, by at most half of what one pass reads
    // so it always moves on; the alert keys dedupe what it reads twice.
    const half = (LOG_CHUNK_BLOCKS * BigInt(LOG_CHUNKS_PER_TICK)) / 2n;
    const overlap = LOG_OVERLAP_BLOCKS < half ? LOG_OVERLAP_BLOCKS : half;
    let cursor =
      w.logCursor === undefined
        ? to > LOG_LOOKBACK_BLOCKS ? to - LOG_LOOKBACK_BLOCKS : 0n
        : w.logCursor > overlap ? w.logCursor - overlap : 0n;
    for (let i = 0; i < LOG_CHUNKS_PER_TICK && cursor <= to; i++) {
      const chunkEnd: bigint = cursor + LOG_CHUNK_BLOCKS - 1n < to ? cursor + LOG_CHUNK_BLOCKS - 1n : to;
      const logs = await client.getLogs({ address: w.vault, events: VAULT_EVENTS, fromBlock: cursor, toBlock: chunkEnd });
      for (const log of logs) {
        const args = log.args as { recipient?: Address; amount?: bigint; principal?: bigint; index?: bigint };
        if (log.eventName === "Disputed") {
          ctx.alerter.alert(
            `psm:disputed:${log.transactionHash}:${log.logIndex}`,
            "seen",
            `psm vault: DISPUTED ${usdc(args.amount ?? 0n)} to ${args.recipient} against principal ` +
              `${usdc(args.principal ?? 0n)} (tx ${log.transactionHash}): a message claimed more than was ever attested`,
          );
        } else if (log.eventName === "CreditUnpayable") {
          ctx.alerter.alert(
            `psm:retired:${args.index}`,
            "retired",
            `psm vault: credit #${args.index} to ${args.recipient} (${usdc(args.amount ?? 0n)}) retired into ` +
              `unpayable: USDC refuses the recipient; claimUnpayable pays it once Circle clears them`,
          );
        }
      }
      cursor = chunkEnd + 1n;
      if (w.logCursor === undefined || cursor > w.logCursor) w.logCursor = cursor;
    }
    if (w.logCursor === undefined || cursor > w.logCursor) w.logCursor = cursor;
    w.logFailures = 0;
    ctx.alerter.clear("psm:getlogs");
  } catch (e) {
    w.logFailures += 1;
    if (w.logFailures >= LOG_FAILURES_ALERT) {
      ctx.alerter.alert(
        "psm:getlogs",
        "failing",
        `psm vault: eth_getLogs has failed ${w.logFailures} times in a row on RPC_BASE; ` +
          `Disputed and retirement alerts are blind until it works (a provider that caps the block ` +
          `range needs a lower PSM_LOG_CHUNK_BLOCKS)`,
      );
    }
    throw e;
  }
}

// ─── Hydration ────────────────────────────────────────────────────

export interface HydrationWatch {
  facilitator: Address;
  flags: Map<string, boolean>;
  pendingSince?: number;
  /** Checks that failed on the last tick. */
  failed: string[];
  hollar?: Address;
  scale?: bigint;
}

export function hydrationWatch(facilitator: Address): HydrationWatch {
  return { facilitator, flags: new Map(), failed: [] };
}

/** The facilitator's alerts: pause flags, and mints left queued for longer than an hour. */
export async function hydrationWatchTick(ctx: KeeperCtx, w: HydrationWatch): Promise<void> {
  const client = ctx.clients.publicClient;
  const read = <T>(functionName: string): Promise<T> =>
    client.readContract({ address: w.facilitator, abi: facilitatorKeeperAbi, functionName } as never) as never;

  w.hollar ??= await read<Address>("hollar");
  w.scale ??= await read<bigint>("scale");

  await checks("psm facilitator watch", ctx, [
    [
      "pauses",
      async () => {
        flag(ctx, w.flags, "facilitator.mintPaused", await read<boolean>("mintPaused"));
        flag(ctx, w.flags, "facilitator.redeemPaused", await read<boolean>("redeemPaused"));
      },
    ],
    [
      "queued mints",
      async () => {
        const pending = await read<bigint>("totalPendingMint");
        if (pending === 0n) {
          w.pendingSince = undefined;
          ctx.alerter.clear("psm:pending");
          return;
        }
        w.pendingSince ??= ctx.now();
        if (ctx.now() - w.pendingSince < LIQUIDITY_STALL_MS) return;
        const [capacity, level] = (await client.readContract({
          address: w.hollar!,
          abi: ghoAbi,
          functionName: "getFacilitatorBucket",
          args: [w.facilitator],
        })) as readonly [bigint, bigint];
        const [, inbound] = await read<readonly [bigint, bigint, bigint, bigint]>("limits");
        const headroom = capacity > level ? (capacity - level) / w.scale! : 0n;
        ctx.alerter.alert(
          "psm:pending",
          "queued",
          `psm facilitator: ${usdc(pending)} of mints queued for over an hour; mint paused ` +
            `${w.flags.get("facilitator.mintPaused")}, bucket headroom ${usdc(headroom)}, inbound allowance ${usdc(inbound)}`,
        );
      },
    ],
  ], w.failed);
}
