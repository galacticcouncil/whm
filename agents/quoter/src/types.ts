import type { Address } from "viem";

/// One per destination chain — the only thing a new chain implements.
export interface ChainQuoter {
  readonly name: string;
  /// Default gas limit used to size the relay cost; overridable per request via `gasLimit`.
  readonly gasLimit: bigint;
  /// Hydration (Omnipool) asset id used to price the chain's native gas token via the TradeRouter.
  readonly gasPricingAssetId: number;
  /// Live gas price, wei.
  gasPrice(): Promise<bigint>;
  /// True when the fee is paid in native (no FX): "native" or the wrapped-native address.
  isNative(feeAsset: string): boolean;
  /// Hydration asset id of an ERC20 fee asset, or undefined if unknown.
  assetIdOf(token: Address): number | undefined;
}

/// Shared: turn a native-wei cost into feeRequested in the delivered asset's units, with `marginBps`
/// applied. The margin is per-request (callers pick their own buffer), not a service-wide constant.
export interface Pricer {
  toFee(chain: ChainQuoter, feeAsset: string, costNative: bigint, marginBps: bigint): Promise<bigint>;
}

export interface RelayFeeQuery {
  chain?: string;
  feeAsset?: string;
  gasLimit?: string;
  marginBps?: string;
}

/// `GET /relay-fee` response. Amounts are decimal strings in the asset's smallest unit.
export interface RelayFeeQuote {
  chain: string;
  feeAsset: string;
  feeRequested: string;
  gasLimit: string;
  gasPriceWei: string;
  costNativeWei: string;
  marginBps: string;
}
