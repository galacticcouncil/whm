import { bitcoin } from "./bitcoin";
import type { UtxoChain, WithdrawChain } from "./types";
import { zcash } from "./zcash";

export type { ConnectorConfig, UtxoChain, WithdrawChain } from "./types";

/** Every chain bridged to Hydration, by route key. A new coin is a new file and an entry here. */
export const CHAINS: Record<string, UtxoChain> = {
  [zcash.name]: zcash,
};

/**
 * Every chain the intents router delivers to through a UTXO route, by route key — the relayer
 * withdraws its deliveries whether or not the coin is bridged to Hydration.
 */
export const ROUTER_CHAINS: Record<string, WithdrawChain> = {
  [zcash.name]: zcash,
  [bitcoin.name]: bitcoin,
};
