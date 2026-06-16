import type { Address } from "viem";

/// One per destination chain — the only thing a new chain implements.
export interface ChainQuoter {
  readonly name: string;
  /// Representative gas limit for `redeem` (uniform call); overridable per request.
  readonly redeemGasLimit: bigint;
  /// Hydration asset id the chain's native maps to, used as the TradeRouter price reference.
  readonly nativeAssetId: number;
  /// Live gas price, wei.
  gasPrice(): Promise<bigint>;
  /// True when the fee is paid in native (no FX): "native" or the wrapped-native address.
  isNative(feeAsset: string): boolean;
  /// Hydration asset id of an ERC20 fee asset, or undefined if unknown.
  assetIdOf(token: Address): number | undefined;
}

/// Shared: turn a native-wei cost into feeRequested in the delivered asset's units.
export interface Pricer {
  toFee(chain: ChainQuoter, feeAsset: string, costNative: bigint): Promise<bigint>;
}

export interface RelayFeeQuery {
  chain?: string;
  feeAsset?: string;
  gasLimit?: string;
}

/// `GET /relay-fee` response. Amounts are decimal strings in the asset's smallest unit.
export interface RelayFeeQuote {
  chain: string;
  feeAsset: string;
  feeRequested: string;
  gasLimit: string;
  gasPriceWei: string;
  costNativeWei: string;
}
