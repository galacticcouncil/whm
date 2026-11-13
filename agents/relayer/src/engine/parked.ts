import type { Alerter } from "./notify";
import type { Next, RelayerCtx } from "../types";

export interface ParkedOptions {
  /** Prefix for the alert text, e.g. the app name. */
  app: string;
  /** Attempt at which a delivery that keeps failing is reported, well before it parks. */
  earlyAttempt: number;
}

/**
 * Error middleware: alerts when a delivery is still failing at `earlyAttempt`, and on its last
 * attempt, after which the engine parks the job in its failed set and nothing re-queues it.
 *
 * The engine runs error middleware without awaiting it and rethrows the error itself, so retries
 * are unaffected; a rejection here would be unhandled and end the process, so nothing may escape.
 * It must keep exactly three parameters: the engine tells error middleware apart by arity.
 *
 * A job that the store fails for stalling (its process died twice while running it) never reaches
 * a handler, so it is not reported here.
 */
export function parkedAlert(alerter: Alerter, opts: ParkedOptions) {
  return function onDeliveryError(err: unknown, ctx: RelayerCtx, next: Next): void {
    try {
      const job = (ctx as Partial<RelayerCtx>).storage?.job;
      if (!job) return;
      const parked = job.attempts >= job.maxAttempts;
      if (!parked && job.attempts !== opts.earlyAttempt) return;

      const { vaa } = ctx;
      const id = `${vaa.emitterChain}/${vaa.emitterAddress.toString("hex")}/${vaa.sequence}`;
      const reason = (err as Error)?.message ?? String(err);
      alerter.alert(
        `delivery:${id}`,
        parked ? "parked" : "failing",
        parked
          ? `${opts.app}: delivery ${id} PARKED after ${job.attempts} attempts — nothing re-queues it; ` +
              `submit the VAA to receiveMessage by hand. Last error: ${reason}`
          : `${opts.app}: delivery ${id} still failing at attempt ${job.attempts}/${job.maxAttempts}: ${reason}`,
      );
    } catch {
      // Reporting only.
    } finally {
      try {
        void Promise.resolve(next()).catch(() => {});
      } catch {
        // Reporting only.
      }
    }
  };
}
