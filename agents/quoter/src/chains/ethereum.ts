import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { chainsMap } from "@galacticcouncil/xc-cfg";

import { logger } from "../logger";
import type { ChainQuoter } from "../types";

export interface EthConfig {
  rpc: string;
  wrappedNative: Address;
  gasLimit: bigint;
  gasPricingAssetId: number;
}

export class EthereumQuoter implements ChainQuoter {
  readonly name = "ethereum";
  readonly gasLimit: bigint;
  readonly gasPricingAssetId: number;

  private readonly client: PublicClient;
  private readonly wrappedNative: string;
  private readonly assetMap: Map<string, number>;

  constructor(cfg: EthConfig) {
    this.gasLimit = cfg.gasLimit;
    this.gasPricingAssetId = cfg.gasPricingAssetId;
    this.wrappedNative = cfg.wrappedNative.toLowerCase();
    this.client = createPublicClient({ transport: http(cfg.rpc) });
    this.assetMap = buildAssetMap();
  }

  gasPrice(): Promise<bigint> {
    return this.client.getGasPrice();
  }

  isNative(feeAsset: string): boolean {
    return feeAsset === "native" || feeAsset.toLowerCase() === this.wrappedNative;
  }

  assetIdOf(token: Address): number | undefined {
    return this.assetMap.get(token.toLowerCase());
  }
}

function buildAssetMap(): Map<string, number> {
  const ethereum = chainsMap.get("ethereum");
  const hydration = chainsMap.get("hydration");
  if (!ethereum || !hydration) {
    throw new Error("xc-cfg: 'ethereum'/'hydration' chain not found");
  }

  const map = new Map<string, number>();
  for (const data of ethereum.assetsData.values()) {
    if (typeof data.id !== "string") {
      continue;
    }
    const hid = hydration.getAssetId(data.asset);
    const id =
      typeof hid === "number"
        ? hid
        : typeof hid === "string" && /^\d+$/.test(hid)
          ? Number(hid)
          : undefined;
    if (id !== undefined) {
      map.set(data.id.toLowerCase(), id);
    }
  }
  logger.info(`Ethereum asset map (${map.size}): ${JSON.stringify(Object.fromEntries(map))}`);
  return map;
}
