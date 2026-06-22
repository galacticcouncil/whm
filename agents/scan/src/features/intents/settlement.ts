import log from "../../logger";
import { broadcast } from "../../subscribers";

import { forwardedPendingSettlement, upsertIntent, type IntentState } from "./db";
import { getExecutionStatus, jwtConfigured, TERMINAL_STATE } from "./oneclick";

const CONCURRENCY = 5;

/**
 * Tracks the off-chain leg: on-chain delivery (`forwarded`) is not the end — the OneClick/NEAR swap
 * still has to settle. Every `intervalMs`, polls 1Click `getExecutionStatus(depositAddress)` for each
 * intent still in `forwarded`, stores the raw status, and advances the intent to a terminal state
 * (`succeeded` / `refunded` / `failed`) once 1Click reports `SUCCESS` / `REFUNDED` / `FAILED`. A
 * terminal intent drops out of the work set, so polling naturally stops for it.
 */
export class SettlementPoller {
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(private readonly intervalMs: number) {}

  start(): void {
    if (!jwtConfigured) {
      log.warn("[intents] ONECLICK_JWT not set — settlement polling will 401 until configured");
    }
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    log.info(`[intents] settlement poller: 1Click getExecutionStatus every ${this.intervalMs}ms`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.busy) return; // skip if a slow round is still running
    this.busy = true;
    try {
      const rows = await forwardedPendingSettlement();
      for (let i = 0; i < rows.length; i += CONCURRENCY) {
        await Promise.all(rows.slice(i, i + CONCURRENCY).map((r) => this.poll(r)));
      }
    } catch (e) {
      log.error(`[intents] settlement tick: ${(e as Error).stack ?? String(e)}`);
    } finally {
      this.busy = false;
    }
  }

  private async poll(r: {
    intent_id: string;
    deposit_address: string;
    settlement_status: string | null;
  }): Promise<void> {
    const status = await getExecutionStatus(r.deposit_address);
    if (!status) return; // transient error — retry next round
    const terminal = TERMINAL_STATE[status];
    // No-op if a non-terminal status is unchanged — avoids churn / redundant SSE broadcasts.
    if (!terminal && status === r.settlement_status) return;

    const state: IntentState = terminal ?? "forwarded";
    // The intent already exists (it's in `forwarded`), so this is always an update — never "created".
    const { row, previousState } = await upsertIntent(r.intent_id, state, {
      settlement_status: status,
    });
    broadcast({
      feature: "intents",
      kind: "updated",
      record: row as unknown as Record<string, unknown>,
      previousState,
    });
  }
}
