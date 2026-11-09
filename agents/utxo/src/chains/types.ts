/** The connector's `get_config()` fields a withdrawal is sized by. */
export interface ConnectorConfig {
  withdraw_bridge_fee: { fee_min: string; fee_rate: number };
  min_change_amount: string;
  min_withdraw_amount: string;
}

/**
 * One UTXO chain — what differs per coin. Mirrors the NEAR contract's `chains/<chain>.rs`; each coin
 * has its own emitter on Hydration and its own `UtxoWithdraw` deployment on NEAR.
 */
export interface UtxoChain {
  /** Route key — `/api/<name>/…`, `<prefix>:<name>:<sequence>`. */
  name: string;
  /** The chain's `UtxoWithdraw` — the predecessor its accounts derive under. */
  contract: string;
  /** An address and the account it derives under `contract`, checked at startup. */
  golden: { address: string; account: string };
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
  /**
   * What the miner takes from a one-input, two-output withdrawal.
   *
   * @param config The connector's config.
   */
  minerFee(config: ConnectorConfig): bigint;
}
