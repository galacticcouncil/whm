import type { WithdrawChain } from "./types";

/** The contract's upper bound for one input and two outputs: 11 + 68 + 2 × 43 vB. */
const VSIZE = 165n;

/** Where the mempool's current rates are read; mempool.space's API by default. */
const MEMPOOL_URL = (process.env.MEMPOOL_URL ?? "https://mempool.space").replace(/\/$/, "");

/**
 * Bitcoin — withdrawals only, of the intents router's deliveries: no Hydration emitter yet. The
 * contract checks every address and prices the fee at its owner's rate, `get_params().fee_rate`.
 */
export const bitcoin: WithdrawChain = {
  name: "bitcoin",
  contract: "withdraw-btc.hydration-whm.near",
  // The connector's change address, derived by the live `v1.signer` under the contract.
  golden: {
    address: "bc1qp42j7hn3lup7gck6y6eks6x2lmnp800t6gy7sk",
    account: "439cbfaea9968fe55d92df661ab036e44ac20e1b346ceacfea1eb4a2b476616b",
  },

  // The contract's: the rate × 165 vB, kept inside the connector's range.
  minerFee: (config, feeRate) => {
    if (feeRate == null) throw new Error("withdraw-btc reports no fee rate");
    let fee = BigInt(feeRate) * VSIZE;
    if (config.max_btc_gas_fee !== undefined && fee > BigInt(config.max_btc_gas_fee)) fee = BigInt(config.max_btc_gas_fee);
    if (config.min_btc_gas_fee !== undefined && fee < BigInt(config.min_btc_gas_fee)) fee = BigInt(config.min_btc_gas_fee);
    return fee;
  },

  /**
   * Whether the next block or so takes a transaction at the contract's rate. A failed read
   * withdraws anyway: the rate is the contract's, so it can only delay, never overpay.
   *
   * @param feeRate The contract's fee rate, sat/vB.
   * @returns True while the half-hour rate is at or under it.
   */
  async ready(feeRate) {
    if (feeRate == null) return true;
    try {
      const res = await fetch(`${MEMPOOL_URL}/api/v1/fees/recommended`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return true;
      const { halfHourFee } = (await res.json()) as { halfHourFee: number };
      return halfHourFee <= feeRate;
    } catch {
      return true;
    }
  },
};
