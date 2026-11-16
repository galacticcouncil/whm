import type { Address } from "viem";

import { revertName } from "../../../engine/revert";

import { facilitatorKeeperAbi, ghoAbi } from "../abi";
import { FLUSH_MAX_PER_TICK, FLUSH_SCAN_BATCH, FLUSH_SWEEP_BATCH } from "../config";
import { checkInflight, isRevert, sendAndWait, type Inflight, type KeeperCtx } from "./common";

export interface FlushTarget {
  facilitator: Address;
  hollar: Address;
  /** HOLLAR units per USDC unit. */
  scale: bigint;
  /** First id ever read (`PSM_FLUSH_FROM_ID`). */
  fromId: bigint;
}

/**
 * Where the keeper is in the pending-mint ids, which are never reused.
 *
 * `frontier` is the first id never read: new ids are read from it each tick, so a fresh entry is
 * seen within a tick however long the history behind it. `live` holds the ids last seen live, and
 * each tick re-reads them. `sweep` walks [fromId, frontier) a few ids per tick, wrapping, for an id
 * a reorg revived after it was dropped.
 */
export interface FlushState {
  frontier: bigint;
  sweep: bigint;
  live: Set<bigint>;
  inflight?: Inflight;
}

export function flushState(target: FlushTarget): FlushState {
  return { frontier: target.fromId, sweep: target.fromId, live: new Set() };
}

export type FlushOutcome =
  | { kind: "inflight" }
  | { kind: "paused" }
  | { kind: "idle" }
  | { kind: "scanned"; live: bigint[]; flushed: bigint[]; skipped: bigint[] };

/**
 * One pass over the pending mints, flushing the ones that fit (spec "Keepers").
 *
 * Ids come from `pendingMints`, not from `MintQueued` logs: a delivery made through substrate
 * `EVM.call` has no ethereum receipt, and `eth_getLogs` cannot see it. Entries are independent, so
 * any that fits is flushed, oldest first, against a budget of the bucket's headroom and the inbound
 * allowance read once per tick; each waits for its receipt before the next, so two flushes never
 * spend the same headroom.
 */
export async function flushTick(ctx: KeeperCtx, target: FlushTarget, state: FlushState): Promise<FlushOutcome> {
  const { facilitator, hollar, scale } = target;

  if (state.inflight) {
    if ((await checkInflight(ctx, state.inflight)).kind === "pending") return { kind: "inflight" };
    state.inflight = undefined;
  }

  // Every read at one block: an RPC pool node a block behind would read a just-queued id below the
  // tail as empty, and the frontier would move past it.
  const blockNumber = await ctx.clients.publicClient.getBlockNumber();
  const read = <T>(functionName: string, args: readonly unknown[] = []): Promise<T> =>
    ctx.clients.publicClient.readContract({ address: facilitator, abi: facilitatorKeeperAbi, functionName, args, blockNumber } as never) as never;
  const amountOf = async (id: bigint): Promise<bigint> =>
    (await read<readonly [Address, Address, boolean, bigint]>("pendingMints", [id]))[3];

  if (await read<boolean>("mintPaused")) return { kind: "paused" };

  const tail = await read<bigint>("pendingTail");
  const amounts = new Map<bigint, bigint>();
  // A live id goes into `live` as soon as it is read, so a read that fails later in the tick, after
  // the frontier has moved past it, loses nothing.
  const found = (id: bigint, amount: bigint) => {
    if (amount === 0n) return;
    amounts.set(id, amount);
    state.live.add(id);
  };

  // New ids, a batch at a time until caught up, the frontier moving past each one read.
  const end = state.frontier + FLUSH_SCAN_BATCH < tail ? state.frontier + FLUSH_SCAN_BATCH : tail;
  while (state.frontier < end) {
    const id = state.frontier;
    found(id, await amountOf(id));
    state.frontier = id + 1n;
  }

  // The slow sweep over everything already read, moving past an id only once it is read.
  for (let i = 0n; i < FLUSH_SWEEP_BATCH && state.frontier > target.fromId; i++) {
    if (state.sweep < target.fromId || state.sweep >= state.frontier) state.sweep = target.fromId;
    const id = state.sweep;
    if (!amounts.has(id) && !state.live.has(id)) found(id, await amountOf(id));
    state.sweep = id + 1n;
  }

  // Ids last seen live, re-read.
  for (const id of state.live) {
    if (amounts.has(id)) continue;
    const amount = await amountOf(id);
    if (amount > 0n) amounts.set(id, amount);
  }

  state.live = new Set(amounts.keys());
  const live = [...amounts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (live.length === 0) return tail === 0n ? { kind: "idle" } : { kind: "scanned", live: [], flushed: [], skipped: [] };

  const [capacity, level] = (await ctx.clients.publicClient.readContract({
    address: hollar,
    abi: ghoAbi,
    functionName: "getFacilitatorBucket",
    args: [facilitator],
    blockNumber,
  })) as readonly [bigint, bigint];
  let headroom = capacity > level ? capacity - level : 0n;
  let [, inbound] = await read<readonly [bigint, bigint, bigint, bigint]>("limits");

  const flushed: bigint[] = [];
  const skipped: bigint[] = [];
  for (const [id, amount] of live) {
    if (flushed.length >= FLUSH_MAX_PER_TICK || !ctx.enabled || amount * scale > headroom || amount > inbound) {
      skipped.push(id);
      continue;
    }
    let sent: Awaited<ReturnType<typeof sendAndWait>>;
    try {
      sent = await sendAndWait(
        ctx,
        { to: facilitator, abi: facilitatorKeeperAbi, functionName: "flushPendingMint", args: [id] },
        `flushPendingMint(${id})`,
      );
    } catch (e) {
      if (!isRevert(e)) throw e;
      // NotQueued: someone flushed or cancelled it first. ExceedsBucketLevel or RateLimitExceeded:
      // something else spent the budget since it was read. Either way, leave it for the next tick.
      skipped.push(id);
      if (revertName(e) === "MintPausedError") break;
      continue;
    }
    if (!sent.hash) {
      skipped.push(id);
      continue;
    }
    flushed.push(id);
    headroom -= amount * scale;
    inbound -= amount;
    if (sent.inflight) {
      state.inflight = sent.inflight;
      break;
    }
  }
  return { kind: "scanned", live: live.map(([id]) => id), flushed, skipped };
}
