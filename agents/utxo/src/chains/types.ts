/** The connector's `get_config()` fields a withdrawal is sized by. */
export interface ConnectorConfig {
  withdraw_bridge_fee: { fee_min: string; fee_rate: number };
  min_change_amount: string;
  min_withdraw_amount: string;
  /** The miner fee range the connector accepts. */
  min_btc_gas_fee?: string;
  max_btc_gas_fee?: string;
}

/**
 * A chain the relayer withdraws to — what differs per coin on the way out. Mirrors the NEAR
 * contract's `chains/<chain>.rs`; each coin has its own `UtxoWithdraw` deployment on NEAR.
 */
export interface WithdrawChain {
  /** Route key — `/api/<name>/…`, `<prefix>:<name>:<sequence>`. */
  name: string;
  /** The chain's `UtxoWithdraw` — the predecessor its accounts derive under. */
  contract: string;
  /** An address and the account it derives under `contract`, checked at startup. */
  golden: { address: string; account: string };
  /**
   * What the miner takes from a one-input, two-output withdrawal — as the contract computes it.
   *
   * @param config The connector's config.
   * @param feeRate The contract's fee rate, sat/vB — `get_params().fee_rate`; null where the chain
   *        fixes its own fee.
   */
  minerFee(config: ConnectorConfig, feeRate: number | null): bigint;
  /**
   * Whether to withdraw now. Where the fee rate can fall below the market's, only while the
   * mempool is at or under it — a withdrawal sent above it waits unconfirmed. Absent: always.
   *
   * @param feeRate The contract's fee rate, sat/vB.
   */
  ready?(feeRate: number | null): Promise<boolean>;
}

/**
 * One UTXO chain bridged to Hydration: a withdraw chain with its own emitter on Hydration and its
 * deposit route.
 */
export interface UtxoChain extends WithdrawChain {
  /** Deposits onto Hydration — the chain's Omni connector, mint target and API name. */
  deposit: {
    /** The chain's Omni connector — the deposit address is its view of the order. */
    connector: string;
    /** Our NTT manager for the coin — the order's `recipient_id`. */
    manager: string;
    /** The Omni Bridge API's name for the chain. */
    omniChain: string;
  };
  /**
   * The address as the emitter takes it, and logs it as `destination`.
   *
   * @param address The address string.
   * @returns Its bytes, or null for anything the emitter would refuse.
   */
  encode(address: string): `0x${string}` | null;
  /**
   * The address string behind the emitter's bytes.
   *
   * @param bytes The event's `destination`.
   * @returns The address string the derivation path is defined over.
   */
  decode(bytes: `0x${string}`): string;
}
