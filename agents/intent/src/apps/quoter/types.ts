/** What a destination delivery costs in gas, and where the number came from. */
export interface GasEstimate {
  total: bigint;
  intrinsic: bigint;
  calldata: bigint;
  execution: bigint;
  /** Signatures each VAA carries — quorum over the live guardian set. */
  signatures: number;
  /** Calldata the call carries, in bytes. */
  calldataBytes: number;
}

/// One per destination chain — the only thing a new chain implements.
export interface ChainQuoter {
  readonly name: string;
  /// Modelled gas for the destination call. See `chains/ethereum.ts` for what is derived and what
  /// is pinned.
  estimateGas(): Promise<GasEstimate>;
  /// What a unit of gas costs — the base fee, which is what the relayer actually pays.
  gasPrice(): Promise<bigint>;
  /// True when `feeAsset` names this chain's native token.
  isNative(feeAsset: string): boolean;
}

export interface RelayFeeQuery {
  chain?: string;
  /// Accepted for compatibility, but only native is quotable — see `routes.ts`.
  feeAsset?: string;
  gasLimit?: string;
  marginBps?: string;
}

/// `GET /relay-fee` response. Amounts are decimal strings in wei.
export interface RelayFeeQuote {
  chain: string;
  feeAsset: string;
  feeRequested: string;
  gasLimit: string;
  gasPriceWei: string;
  costNativeWei: string;
  marginBps: string;
  /// The estimate's parts, so a caller can see why the number moved. Absent when `gasLimit` was
  /// overridden by the request, since then nothing was modelled.
  gas?: {
    intrinsic: string;
    calldata: string;
    execution: string;
    signatures: number;
    calldataBytes: number;
  };
}
