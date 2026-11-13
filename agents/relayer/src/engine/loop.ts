import { setTimeout as sleep } from "timers/promises";

import logger from "../logger";

/**
 * Run `tick` every `ms` for the life of the process, one tick at a time.
 *
 * A tick that throws is logged and the loop goes on. Nothing here may become an unhandled
 * rejection: that ends the process, and with it every delivery the process serves.
 *
 * @param label Name for the log.
 * @param ms Pause between the end of one tick and the start of the next.
 * @param tick The work.
 * @param onFailure Called with the run of consecutive failures and the latest error.
 * @returns A function that stops the loop after the current tick.
 */
export function every(
  label: string,
  ms: number,
  tick: () => Promise<void>,
  onFailure?: (consecutive: number, error: unknown) => void,
): () => void {
  let stopped = false;
  let failures = 0;

  const run = async () => {
    while (!stopped) {
      try {
        await tick();
        failures = 0;
      } catch (e) {
        failures += 1;
        logger.error(`${label} tick failed (${failures} in a row): ${(e as Error)?.message ?? String(e)}`);
        try {
          onFailure?.(failures, e);
        } catch {
          // The failure hook is reporting; it cannot be allowed to end the loop.
        }
      }
      if (!stopped) await sleep(ms);
    }
  };
  run().catch((e) => logger.error(`${label} loop ended: ${(e as Error)?.message ?? String(e)}`));

  return () => {
    stopped = true;
  };
}
