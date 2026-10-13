import { OneClickService, OpenAPI } from "@defuse-protocol/one-click-sdk-typescript";

import { oneClickJwt } from "../../config";
import log from "../../logger";

/** 1Click requires a JWT on the SDK's shared config; without it every call 401s. */
export const jwtConfigured = Boolean(oneClickJwt);
if (oneClickJwt) OpenAPI.TOKEN = oneClickJwt;

/**
 * 1Click execution status to terminal order state. The non-terminal ones — PENDING_DEPOSIT,
 * INCOMPLETE_DEPOSIT, KNOWN_DEPOSIT_TX, PROCESSING — are deliberately absent, so the poller keeps
 * polling until one of these lands.
 */
export const TERMINAL_STATE: Record<string, string> = {
  SUCCESS: "settled",
  REFUNDED: "refunded",
  FAILED: "failed",
};

/**
 * Execution status plus the destination leg, recovered from the original quote. Address and asset
 * are known at quote time; the amount and the destination-chain transaction only appear once 1Click
 * settles — and on a refund they never do.
 */
export interface ExecutionInfo {
  status: string;
  /** Recipient on the destination chain — not the Ethereum deposit address. */
  destAddress?: string;
  /** 1Click asset id, which encodes the destination chain. */
  destAsset?: string;
  /**
   * What actually settled. Deliberately not defaulted to the quote: a refunded order still carries
   * the output it was quoted, and reporting that as delivered is how a page ends up claiming the
   * user received tokens that were never sent.
   */
  destAmount?: string;
  destTx?: string;
  destTxUrl?: string;
  /** What the quote promised. An expectation while pending, and nothing more once it is not. */
  quotedAmount?: string;
  /** Origin asset returned to `refundTo` — ETH here, since that is what was deposited. */
  refundAmount?: string;
  refundReason?: string;
  refundTx?: string;
  refundTxUrl?: string;
}

/**
 * Ask 1Click where a deposit address' funds went.
 *
 * @param depositAddress The address the order forwarded to.
 * @returns Status and destination, or null on a transient error — the next round retries.
 */
export async function getExecution(depositAddress: string): Promise<ExecutionInfo | null> {
  try {
    const r = await OneClickService.getExecutionStatus(depositAddress);
    const req = r.quoteResponse?.quoteRequest;
    const destTx = r.swapDetails?.destinationChainTxHashes?.[0];
    // The refund is the last thing to happen on the origin chain; the deposit that preceded it may
    // be in this list too.
    const originTx = r.swapDetails?.originChainTxHashes?.at(-1);
    return {
      status: String(r.status),
      destAddress: req?.recipient,
      destAsset: req?.destinationAsset,
      destAmount: r.swapDetails?.amountOut,
      destTx: destTx?.hash,
      destTxUrl: destTx?.explorerUrl,
      quotedAmount: r.quoteResponse?.quote?.amountOut,
      refundAmount: r.swapDetails?.refundedAmount,
      refundReason: r.swapDetails?.refundReason,
      refundTx: originTx?.hash,
      refundTxUrl: originTx?.explorerUrl,
    };
  } catch (e) {
    log.warn(`[intents] getExecution ${depositAddress}: ${(e as Error).message}`);
    return null;
  }
}
