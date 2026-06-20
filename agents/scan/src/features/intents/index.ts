import { pad, toEventSelector } from "viem";

import type { Feature } from "../../types";
import type { Enrich } from "../../enrich";
import { chains, intentsConfig } from "../../config";

import { intentsHandlers } from "./handlers";
import { LogMessagePublishedEvt } from "./abi";
import { routes } from "./api";
import { initSchema, stateCounts } from "./db";

/**
 * NEAR-Intents (WTT) indexer: Hydration `BridgeInitiated` (emitted) → Moonbeam Wormhole-core
 * `LogMessagePublished` (published, in-flight) → Ethereum `IntentForwarded`/`RelayFeePaid`
 * (forwarded), correlated by intentId. The Moonbeam leg filters the Wormhole-core firehose to the
 * TokenBridge's publishes via a sender topic, then keeps only transfers addressed to the receiver.
 *
 * @param enrich shared per-chain enrichment passed to the handlers
 */
export function createIntents(enrich: Enrich): Feature | null {
  const { emitterHydration, receiverEthereum, wormholeCoreMoonbeam, tokenBridgeMoonbeam } =
    intentsConfig;

  // The receiver address is needed to filter/decode both the published and forwarded legs.
  if (!receiverEthereum) return null;
  const h = intentsHandlers(enrich, receiverEthereum);

  const contracts: Feature["contracts"] = [];

  if (chains["hydration"] && emitterHydration) {
    contracts.push({ chain: "hydration", address: emitterHydration, events: [h.emitted] });
  }

  if (chains["moonbeam"] && wormholeCoreMoonbeam && tokenBridgeMoonbeam) {
    contracts.push({
      chain: "moonbeam",
      address: wormholeCoreMoonbeam,
      // narrow the Wormhole-core firehose to the TokenBridge's publishes (indexed `sender`)
      topics: [toEventSelector(LogMessagePublishedEvt), pad(tokenBridgeMoonbeam, { size: 32 })],
      events: [h.published],
    });
  }

  if (chains["ethereum"]) {
    contracts.push({
      chain: "ethereum",
      address: receiverEthereum,
      events: [h.forwarded, h.relayFee],
    });
  }

  if (contracts.length === 0) return null;

  return {
    name: "intents",
    contracts,
    initSchema,
    routes,
    counts: stateCounts,
  };
}
