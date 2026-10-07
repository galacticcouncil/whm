import type { Address } from "viem";

import log from "../logger.js";

import type { EvmFeed, EvmWallet } from "./broadcaster.js";

/** How often a stale round is re-reported while it stays stale. */
const WARN_EVERY_MS = 60 * 60 * 1_000;

/**
 * How old a round is, in whatever time counts for its feed.
 *
 * @param fromSec The round's `updatedAt`, unix seconds.
 * @param toSec Now, unix seconds.
 * @returns Age in seconds.
 */
export type RoundAge = (fromSec: number, toSec: number) => number;

/** Wall-clock age — right for a 24/7 feed. */
const wallClock: RoundAge = (fromSec, toSec) => toSec - fromSec;

// AggregatorV3Adapter (contracts/src/oracles/adapters/AggregatorV3Adapter.sol) + the Chainlink proxy behind it
const ADAPTER_V3_ABI = [
  {
    type: "function",
    name: "feed",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

/**
 * Build a check that warns when the Chainlink round behind an AggregatorV3Adapter source is older than
 * `staleAfter` — a dead feed, which publishing alone hides because the adapter keeps returning its
 * last answer.
 *
 * @param client Public client on the adapters' chain.
 * @param staleAfter Bound in seconds, measured by `age`.
 * @param age How a round's age is counted; wall-clock by default, open-market time for equities.
 * @returns The check. It never throws, so it cannot block the read it runs beside.
 */
export function roundWatch(
  client: EvmWallet["publicClient"],
  staleAfter: number,
  age: RoundAge = wallClock,
): (feed: EvmFeed) => Promise<void> {
  /** Adapter source -> Chainlink proxy; immutable on-chain, so resolved once. */
  const proxies = new Map<Address, Address>();
  /** Last warning per feed key, so an outage logs hourly rather than every tick. */
  const warnedAt = new Map<string, number>();

  return async (feed) => {
    try {
      let proxy = proxies.get(feed.source);
      if (!proxy) {
        proxy = (await client.readContract({
          address: feed.source,
          abi: ADAPTER_V3_ABI,
          functionName: "feed",
        })) as Address;
        proxies.set(feed.source, proxy);
        log.info(`  [stale] ${feed.label} watching chainlink ${proxy} (bound ${staleAfter}s)`);
      }

      const [, , , updatedAt] = (await client.readContract({
        address: proxy,
        abi: ADAPTER_V3_ABI,
        functionName: "latestRoundData",
      })) as readonly [bigint, bigint, bigint, bigint, bigint];

      const now = Date.now();
      const elapsed = age(Number(updatedAt), Math.floor(now / 1_000));
      if (elapsed <= staleAfter) {
        warnedAt.delete(feed.key);
        return;
      }

      if (now - (warnedAt.get(feed.key) ?? 0) < WARN_EVERY_MS) return;
      warnedAt.set(feed.key, now);
      log.warn(
        `  [stale] ${feed.label} chainlink round ${(elapsed / 3_600).toFixed(1)}h old (updatedAt ${updatedAt}, bound ${staleAfter}s) — still publishing`,
      );
    } catch (err) {
      log.warn(`  [stale] ${feed.label} round check failed:`, err);
    }
  };
}
