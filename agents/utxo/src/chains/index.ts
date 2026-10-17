import type { UtxoChain } from "./types";
import { zcash } from "./zcash";

export type { ConnectorConfig, UtxoChain } from "./types";

/** Every supported chain, by route key. A new coin is a new file and an entry here. */
export const CHAINS: Record<string, UtxoChain> = {
  [zcash.name]: zcash,
};
