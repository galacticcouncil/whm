import type { Feature } from "../types";
import type { Enrich } from "../enrich";

import { createBasejump } from "./basejump";
import { createIntents } from "./intents";

/**
 * Instantiate every feature, dropping those with no configured contract on an enabled chain.
 * Add a feature by appending its factory here.
 *
 * @param enrich shared per-chain enrichment handed to each feature's handlers
 */
export function buildFeatures(enrich: Enrich): Feature[] {
  return [createBasejump(enrich), createIntents(enrich)].filter((f): f is Feature => f !== null);
}
