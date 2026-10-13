import type { Address } from "viem";

import { optionalBigint, required } from "../../env";
import type { EthConfig } from "./chains/ethereum";

export const APP_NAME = "quoter";

/** Wormhole core bridge, Ethereum mainnet. */
const WORMHOLE_CORE_ETHEREUM = "0x98f3c9e6E3fAce36bAAd05FE09d375Ef1464288B";

export const config = {
  /**
   * Default margin when a request names none.
   *
   * Zero: this service answers what the delivery costs, and the caller owns its own headroom — the
   * SDK asks with `marginBps=2000`. A non-zero default would silently bias every quote that forgot
   * to pass one.
   */
  feeMarginBps: optionalBigint("FEE_MARGIN_BPS", 0n),
  ethereum: {
    rpc: required("ETH_RPC"),
    wormholeCore: (process.env.ETH_WORMHOLE_CORE ?? WORMHOLE_CORE_ETHEREUM) as Address,
    // Escape hatch, normally unset — the modelled envelope is the source of truth.
    gasLimitOverride: process.env.ETH_GAS_LIMIT ? BigInt(process.env.ETH_GAS_LIMIT) : undefined,
  } satisfies EthConfig,
};
