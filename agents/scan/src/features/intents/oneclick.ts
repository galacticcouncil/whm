import { OneClickService, OpenAPI } from "@defuse-protocol/one-click-sdk-typescript";

import log from "../../logger";
import { oneClickJwt } from "../../config";
import type { IntentState } from "./db";

// 1Click requires a JWT (set on the SDK's shared OpenAPI config). Without it, calls 401.
export const jwtConfigured = Boolean(oneClickJwt);
if (oneClickJwt) OpenAPI.TOKEN = oneClickJwt;

/**
 * 1Click execution status → terminal intent state. Non-terminal statuses (PENDING_DEPOSIT,
 * INCOMPLETE_DEPOSIT, KNOWN_DEPOSIT_TX, PROCESSING) are absent, so the poller keeps polling.
 */
export const TERMINAL_STATE: Record<string, IntentState> = {
  SUCCESS: "succeeded",
  REFUNDED: "refunded",
  FAILED: "failed",
};

/**
 * Poll 1Click for the execution status of a deposit address (no auth needed; uses the SDK's
 * default prod endpoint, same as `nintent`).
 *
 * @param depositAddress the OneClick quote deposit address that received the forwarded ETH
 * @returns the raw status string (e.g. `PROCESSING`, `SUCCESS`), or null on a transient error
 */
export async function getExecutionStatus(depositAddress: string): Promise<string | null> {
  try {
    const r = await OneClickService.getExecutionStatus(depositAddress);
    return r.status;
  } catch (e) {
    log.warn(`[intents] getExecutionStatus ${depositAddress}: ${(e as Error).message}`);
    return null;
  }
}
