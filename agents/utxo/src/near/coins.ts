import type { JsonRpcProvider } from "near-api-js";

import type { ConnectorConfig } from "../chains";

import { view } from "./client";

/** A connector coin: `txid@vout` and its value, in the chain's base unit. */
export type Coin = [id: string, value: bigint];

/** Coins per `get_utxos_paged` page. */
const PAGE = 20;

/**
 * A connector's whole coin set — ~50 pages for Zcash today, so read once per pass and shared.
 *
 * @param provider A NEAR provider.
 * @param connector The chain's connector.
 * @returns Every coin.
 */
export async function listCoins(provider: JsonRpcProvider, connector: string): Promise<Coin[]> {
  const coins: Coin[] = [];
  for (let from = 0; ; from += PAGE) {
    const page = await view<Record<string, { balance: string }>>(provider, connector, "get_utxos_paged", {
      from_index: from,
      limit: PAGE,
    });
    const entries = Object.entries(page);
    coins.push(...entries.map(([id, coin]): Coin => [id, BigInt(coin.balance)]));
    if (entries.length < PAGE) return coins;
  }
}

/**
 * Best fit — the smallest coin that pays the withdrawal exactly or leaves change of at least
 * `min_change_amount`; the contract's arithmetic, off-chain. A coin spent in between makes the
 * contract refuse rather than misspend.
 *
 * @param coins The connector's coin set.
 * @param config The connector's config.
 * @param balance What the account withdraws, at or above `min_withdraw_amount`.
 * @param minerFee What the miner takes from the withdrawal.
 * @returns The coin as `txid:vout`.
 * @throws When the balance does not cover the fees, or no coin fits.
 */
export function pickCoin(coins: Coin[], config: ConnectorConfig, balance: bigint, minerFee: bigint): string {
  const { fee_min, fee_rate } = config.withdraw_bridge_fee;
  const rated = (balance * BigInt(fee_rate)) / 10_000n;
  const bridgeFee = rated > BigInt(fee_min) ? rated : BigInt(fee_min);
  if (balance <= bridgeFee + minerFee) throw new Error(`balance ${balance} does not cover the fees`);

  // The coin pays the user output and the miner fee; the bridge fee stays with Omni.
  const need = balance - bridgeFee;
  const minChange = BigInt(config.min_change_amount);

  const fitting = coins
    .filter(([, value]) => value === need || value >= need + minChange)
    .sort(([ia, a], [ib, b]) => (a === b ? ia.localeCompare(ib) : a < b ? -1 : 1));
  if (fitting.length === 0) throw new Error(`no coin covers ${need}`);
  return fitting[0][0].replace("@", ":");
}
