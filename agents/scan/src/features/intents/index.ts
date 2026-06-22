import { pad, toEventSelector } from "viem";

import type { Feature } from "../../types";
import type { Enrich } from "../../enrich";
import { chains, intentsConfig, intentsSettlementPollMs } from "../../config";

import { intentsHandlers } from "./handlers";
import { SettlementPoller } from "./settlement";
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

  // At least one receiver gates/decodes both the published and forwarded legs.
  if (receiverEthereum.length === 0) return null;
  const h = intentsHandlers(enrich, receiverEthereum);

  const contracts: Feature["contracts"] = [];

  if (chains["hydration"]) {
    for (const address of emitterHydration) {
      contracts.push({ chain: "hydration", address, events: [h.emitted] });
    }
  }

  if (chains["moonbeam"]) {
    contracts.push({
      chain: "moonbeam",
      address: wormholeCoreMoonbeam,
      // narrow the Wormhole-core firehose to the TokenBridge's publishes (indexed `sender`)
      topics: [toEventSelector(LogMessagePublishedEvt), pad(tokenBridgeMoonbeam, { size: 32 })],
      events: [h.published],
    });
  }

  if (chains["ethereum"]) {
    for (const address of receiverEthereum) {
      contracts.push({ chain: "ethereum", address, events: [h.forwarded, h.relayFee] });
    }
  }

  if (contracts.length === 0) return null;

  const poller = new SettlementPoller(intentsSettlementPollMs);

  return {
    name: "intents",
    contracts,
    initSchema,
    routes,
    counts: stateCounts,
    start: () => poller.start(),
  };
}
