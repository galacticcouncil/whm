import { client as sdkClient } from "@galacticcouncil/sdk-next";
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";

import { CHAINS } from "../../chains";
import log from "../../logger";

/** An asset's ERC20 precompile: `0x0100000000 | assetId`. */
const PRECOMPILE = /^0x0{31}1([0-9a-f]{8})$/;

let erc20: Promise<Map<string, number>> | undefined;

/**
 * The ERC20-type Hydration assets by contract address, read from the registry once: such an asset is
 * located at its contract, X1(AccountKey20).
 *
 * @returns Asset ids by lowercase address.
 */
function erc20Assets(): Promise<Map<string, number>> {
  return (erc20 ??= (async () => {
    const out = new Map<string, number>();
    const cfg = CHAINS["hydration"];
    if (!cfg || cfg.kind !== "substrate") return out;
    const client = createClient(getWsProvider(cfg.wssUrl));
    try {
      for (const a of await new sdkClient.AssetClient(client).getSupported()) {
        const at = a.location?.interior;
        if (a.type === "Erc20" && at?.type === "X1" && at.value.type === "AccountKey20") {
          out.set(at.value.value.key.toLowerCase(), a.id);
        }
      }
    } catch (e) {
      log.warn(`[intents-v2] hydration erc20 assets: ${(e as Error).message}`);
    } finally {
      client.destroy();
    }
    return out;
  })());
}

/**
 * The Hydration asset an EVM address names — what ICE gives `execute` as the asset sold: a
 * precompile's id, or the ERC20-type asset at that contract.
 *
 * @param address The address.
 * @returns The asset id, or undefined when no asset is at the address.
 */
export async function hydrationAssetId(address: string): Promise<number | undefined> {
  const a = address.toLowerCase();
  const precompile = PRECOMPILE.exec(a);
  if (precompile) return parseInt(precompile[1]!, 16);
  return (await erc20Assets()).get(a);
}
