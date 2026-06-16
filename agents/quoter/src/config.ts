import type { Address } from "viem";

import type { EthConfig } from "./chains/ethereum";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  feeMarginBps: BigInt(process.env.FEE_MARGIN_BPS ?? "2000"),
  hydrationRpc: req("HYDRATION_RPC"),
  ethereum: {
    rpc: req("ETH_RPC"),
    wrappedNative: req("ETH_WRAPPED_NATIVE") as Address,
    gasLimit: BigInt(process.env.ETH_GAS_LIMIT ?? "150000"),
    gasPricingAssetId: Number(req("ETH_GAS_PRICING_ASSET_ID")),
  } satisfies EthConfig,
};
