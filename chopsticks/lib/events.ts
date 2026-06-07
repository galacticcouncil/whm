import * as c from "console";

import { type HydrationQueries } from "@galacticcouncil/descriptors";

import { toJson } from "./utils";

export type EventRecord = HydrationQueries["System"]["Events"]["Value"][number];

type Pallet = EventRecord["event"]["type"];

export function findEvent(events: EventRecord[], pallet: Pallet, method: string): unknown {
  return events.find((e) => e.event.type === pallet && e.event.value.type === method)?.event.value
    .value;
}

export function checkIfExtrinsicFailed(events: EventRecord[]): boolean {
  return events.some(({ event }) => {
    if (event.type === "System" && event.value.type === "ExtrinsicFailed") {
      c.error("🥢 ExtrinsicFailed:", toJson(event.value, 0));
      return true;
    }
    return false;
  });
}

export function checkIfEthereumExecuted(events: EventRecord[]): boolean {
  return events.some(({ event }) => {
    if (event.type === "Ethereum" && event.value.type === "Executed") {
      c.error("🥢 Executed:", toJson(event.value, 0));
      return true;
    }
    return false;
  });
}

export function checkIfQueueProcessed(events: EventRecord[]): boolean {
  return events.some(
    ({ event }) =>
      event.type === "MessageQueue" &&
      event.value.type === "Processed" &&
      event.value.value.success === true,
  );
}

export function logEvents(events: EventRecord[]) {
  for (const { event } of events) {
    c.log("🥢 Event:", toJson(event, 0));
  }
}
