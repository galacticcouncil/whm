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
 * The execution status plus the destination leg of the swap, recovered from the original quote.
 * The destination address/asset/amount are known at quote time (so available from `emitted`); the
 * destination-chain tx only appears once 1Click settles the swap.
 */
export interface ExecutionInfo {
  status: string;
  /** recipient on the destination chain — NOT the Ethereum deposit address */
  destAddress?: string;
  /** 1Click destination asset id (encodes the destination chain) */
  destAsset?: string;
  /** settled output amount if available, else the quoted output amount */
  destAmount?: string;
  /** destination-chain settlement tx hash (present once SUCCESS) */
  destTx?: string;
  destTxUrl?: string;
}

/**
 * Fetch a deposit address's execution status + destination leg from 1Click (uses the SDK's default
 * prod endpoint, same as `nintent`). The deposit address derives from a quote, so the destination
 * `recipient`/`destinationAsset`/`amountOut` are returned even before any deposit is detected.
 *
 * @param depositAddress the OneClick quote deposit address that received the forwarded ETH
 * @returns status + destination fields, or null on a transient error
 */
export async function getExecution(depositAddress: string): Promise<ExecutionInfo | null> {
  try {
    const r = await OneClickService.getExecutionStatus(depositAddress);
    const req = r.quoteResponse?.quoteRequest;
    const destTx = r.swapDetails?.destinationChainTxHashes?.[0];
    return {
      status: String(r.status),
      destAddress: req?.recipient,
      destAsset: req?.destinationAsset,
      destAmount: r.swapDetails?.amountOut ?? r.quoteResponse?.quote?.amountOut,
      destTx: destTx?.hash,
      destTxUrl: destTx?.explorerUrl,
    };
  } catch (e) {
    log.warn(`[intents] getExecution ${depositAddress}: ${(e as Error).message}`);
    return null;
  }
}
