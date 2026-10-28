import { decodeEventLog, type Address, type Hash, type TransactionReceipt } from "viem";

import { revertName } from "../../../engine/revert";

import { vaultKeeperAbi } from "../abi";
import { DRAIN_GAS_BASE, DRAIN_GAS_PER_ENTRY, DRAIN_MAX_ENTRIES, LIQUIDITY_STALL_MS } from "../config";
import { checkInflight, isRevert, sendAndWait, usdc, type Inflight, type KeeperCtx } from "./common";

const UNLIMITED = (1n << 256n) - 1n;

export interface DrainState {
  inflight?: Inflight;
}

export type DrainOutcome =
  | { kind: "inflight" }
  | { kind: "paused" }
  | { kind: "empty" }
  | { kind: "held"; index: bigint; reason: string }
  | { kind: "disabled"; index: bigint }
  | { kind: "reverting"; index: bigint; reason: string }
  | { kind: "sent"; hash?: Hash; maxEntries: bigint; settled?: number; paid?: bigint; retired?: number };

type Read = <T>(functionName: string, args?: readonly unknown[]) => Promise<T>;

/**
 * One look at the vault's queue, and at most one `drain` (spec "Keepers").
 *
 * Whether the head is payable is asked of the vault itself: `claim()` simulated from the head's own
 * address reverts with the reason it cannot be paid, or not at all. A blacklisted head
 * (`RecipientUnpayable`) is drained like any other: `drain` retires it into `unpayable`, which
 * `claimUnpayable` pays once Circle clears the address, and every retirement is alerted.
 */
export async function drainTick(ctx: KeeperCtx, vault: Address, state: DrainState): Promise<DrainOutcome> {
  const read: Read = (functionName, args = []) =>
    ctx.clients.publicClient.readContract({ address: vault, abi: vaultKeeperAbi, functionName, args } as never) as never;

  if (state.inflight) {
    const status = await checkInflight(ctx, state.inflight);
    if (status.kind === "pending") return { kind: "inflight" };
    state.inflight = undefined;
    if (status.kind === "mined") {
      if (status.receipt.status === "success") report(ctx, vault, status.receipt);
      else ctx.log.warn(`psm drain: ${status.receipt.transactionHash} reverted on chain`);
    }
  }

  if (await read<boolean>("claimsPaused")) return { kind: "paused" };
  const [recipient, amount] = await read<readonly [Address, bigint]>("queueHeadEntry");
  if (amount === 0n) return { kind: "empty" };
  const index = await read<bigint>("queueHead");

  const blocker = await headBlocker(ctx, vault, recipient);
  if (blocker === "ClaimsPaused") return { kind: "paused" };
  if (blocker === "RecipientUnpayable") {
    ctx.alerter.alert(
      `psm:head-blacklisted:${index}`,
      "blacklisted",
      `psm vault: head #${index} ${recipient} (${usdc(amount)}) is blacklisted by USDC; drain retires it ` +
        `into unpayable, which claimUnpayable pays once Circle clears it`,
    );
  } else if (blocker) {
    return held(ctx, read, index, recipient, amount, blocker);
  }

  if (!ctx.enabled) return { kind: "disabled", index };

  // The spec's fallback: an Aave refusal or a non-blacklist transfer failure anywhere in the batch
  // reverts it whole, while drain(1) can still clear a head that idle USDC covers.
  let reason = "";
  for (const maxEntries of [DRAIN_MAX_ENTRIES, 1n]) {
    let sent: Awaited<ReturnType<typeof sendAndWait>>;
    try {
      sent = await sendAndWait(
        ctx,
        { to: vault, abi: vaultKeeperAbi, functionName: "drain", args: [maxEntries] },
        `drain(${maxEntries})`,
        { gasFloor: DRAIN_GAS_BASE + maxEntries * DRAIN_GAS_PER_ENTRY },
      );
    } catch (e) {
      if (!isRevert(e)) throw e;
      reason = revertName(e) ?? "unnamed revert";
      // A pause that landed between the head check and the send.
      if (reason === "ClaimsPaused") return { kind: "paused" };
      continue;
    }
    if (sent.inflight) state.inflight = sent.inflight;
    ctx.alerter.clear("psm:drain-reverting");
    ctx.alerter.clear("psm:payout-closed");
    return { kind: "sent", hash: sent.hash, maxEntries, ...(sent.receipt ? report(ctx, vault, sent.receipt) : {}) };
  }

  ctx.alerter.alert(
    "psm:drain-reverting",
    reason,
    `psm vault: drain(${DRAIN_MAX_ENTRIES}) and drain(1) revert (${reason}) at head #${index}; check USDC and the Aave pool`,
  );
  return { kind: "reverting", index, reason };
}

/** What `claim()` from the head's own address reverts with, or undefined when it would pay. */
async function headBlocker(ctx: KeeperCtx, vault: Address, recipient: Address): Promise<string | undefined> {
  try {
    await ctx.clients.publicClient.simulateContract({
      address: vault,
      abi: vaultKeeperAbi,
      functionName: "claim",
      account: recipient,
    });
    return undefined;
  } catch (e) {
    if (!isRevert(e)) throw e;
    return revertName(e) ?? "unnamed revert";
  }
}

async function held(
  ctx: KeeperCtx,
  read: Read,
  index: bigint,
  recipient: Address,
  amount: bigint,
  reason: string,
): Promise<DrainOutcome> {
  if (reason === "InsufficientPayoutAllowance") {
    const [, , , capacity, window, available] = await read<readonly bigint[]>("limits");
    if (capacity === 0n) {
      ctx.alerter.alert(
        "psm:payout-closed",
        "closed",
        `psm vault: the payout limit is closed (capacity 0); nothing pays until setPayoutLimit`,
      );
      return { kind: "held", index, reason };
    }
    ctx.alerter.clear("psm:payout-closed");
    if (capacity !== UNLIMITED && amount > capacity) {
      ctx.alerter.alert(
        `psm:head-above-capacity:${index}`,
        capacity.toString(),
        `psm vault: head #${index} (${usdc(amount)}) is above the payout capacity ${usdc(capacity)} and can ` +
          `never be paid; the exits are the Safe's cancelQueuedRedemptionFor(${index}) or a setPayoutLimit raise`,
      );
    } else {
      const short = amount > available ? amount - available : 0n;
      const eta = window > 0n ? (short * window + capacity - 1n) / capacity : 0n;
      ctx.log.info(`psm drain: head #${index} (${usdc(amount)}) waits on the payout allowance, about ${eta}s`);
    }
  } else if (reason === "InsufficientLiquidity") {
    const since = await read<bigint>("headSince");
    const waited = BigInt(Math.floor(ctx.now() / 1000)) - since;
    if (waited * 1000n > BigInt(LIQUIDITY_STALL_MS)) {
      ctx.alerter.alert(
        `psm:head-liquidity:${index}`,
        "stalled",
        `psm vault: head #${index} (${usdc(amount)}) held by the reserve's liquidity for ${Math.round(Number(waited) / 60)} min; ` +
          `its origin's cancel opens 24 h after it reached the head`,
      );
    }
  } else if (reason !== "NotAtQueueHead") {
    // PayoutFailed (USDC refused a recipient it has not blacklisted), an Aave refusal, or anything
    // else `claim` raised. `NotAtQueueHead` only means the head moved between the reads.
    ctx.alerter.alert(
      `psm:head-unpayable:${index}`,
      reason,
      `psm vault: head #${index} ${recipient} (${usdc(amount)}) cannot be paid: ${reason}`,
    );
  }
  return { kind: "held", index, reason };
}

/** Count what a mined drain paid, and alert every credit it retired. */
function report(ctx: KeeperCtx, vault: Address, receipt: TransactionReceipt) {
  let settled = 0;
  let paid = 0n;
  let retired = 0;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== vault.toLowerCase()) continue;
    let ev;
    try {
      ev = decodeEventLog({ abi: vaultKeeperAbi, data: log.data, topics: log.topics });
    } catch {
      continue;
    }
    if (ev.eventName === "Claimed") {
      settled += 1;
      paid += ev.args.amount;
    } else if (ev.eventName === "CreditUnpayable") {
      retired += 1;
      ctx.alerter.alert(
        `psm:retired:${ev.args.index}`,
        "retired",
        `psm vault: credit #${ev.args.index} to ${ev.args.recipient} (${usdc(ev.args.amount)}) retired into ` +
          `unpayable: USDC refuses the recipient; claimUnpayable pays it once Circle clears them`,
      );
    }
  }
  ctx.log.info(`psm drain ${receipt.transactionHash}: paid ${settled} (${usdc(paid)}), retired ${retired}`);
  return { settled, paid, retired };
}
