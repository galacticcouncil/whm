import { createSdkContext } from "@galacticcouncil/sdk-next";
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import type { Address } from "viem";

import type { ChainQuoter, Pricer } from "./types";

const BPS = 10_000n;

export class HydrationPricer implements Pricer {
  private _router?: Promise<Awaited<ReturnType<typeof createSdkContext>>["api"]["router"]>;

  constructor(private readonly hydrationRpc: string) {}

  private router() {
    if (!this._router) {
      this._router = (async () => {
        const client = createClient(getWsProvider(this.hydrationRpc));
        const sdk = await createSdkContext(client);
        return sdk.api.router;
      })();
    }
    return this._router;
  }

  private withMargin(x: bigint, marginBps: bigint): bigint {
    return (x * (BPS + marginBps)) / BPS;
  }

  async toFee(
    chain: ChainQuoter,
    feeAsset: string,
    costNative: bigint,
    marginBps: bigint,
  ): Promise<bigint> {
    if (chain.isNative(feeAsset)) {
      return this.withMargin(costNative, marginBps);
    }

    const assetId = chain.assetIdOf(feeAsset as Address);
    if (assetId === undefined) {
      throw new Error(`No Hydration asset id for fee asset ${feeAsset}`);
    }

    const router = await this.router();
    const trade = await router.getBestSell(chain.gasPricingAssetId, assetId, costNative);
    return this.withMargin(trade.amountOut, marginBps);
  }
}
