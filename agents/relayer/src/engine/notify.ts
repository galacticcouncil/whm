import { setTimeout as sleep } from "timers/promises";

import logger from "../logger";

/** Discord rejects content past 2000 characters. */
const MAX_CONTENT = 1900;

/** Waits before each retry of an alert whose post failed; the last repeats until Discord takes it. */
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000];

/** Alerts still being retried; past this many, the oldest is dropped with a log line. */
const MAX_UNDELIVERED = 500;

/**
 * Post one message to a Discord webhook. Never throws, and gives up after 10 s.
 *
 * `fetch` is resolved at call time: the Wormhole SDK swaps the global at import and `boot` restores
 * it, and the verify scripts mock the global, so a reference captured at load would bypass both.
 *
 * @param webhook Webhook URL; nothing is sent without one.
 * @param message Message text, truncated to what Discord accepts.
 * @returns Whether Discord took it. True without a webhook: the log line is the alert.
 */
export async function notifyDiscord(webhook: string | undefined, message: string): Promise<boolean> {
  if (!webhook) return true;
  try {
    const res = await globalThis.fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message.slice(0, MAX_CONTENT) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return true;
    logger.error(`Discord notification refused: HTTP ${res.status}`);
  } catch (e) {
    logger.error(`Failed to send Discord notification: ${(e as Error).message}`);
  }
  return false;
}

export interface Alerter {
  /**
   * Raise `key` in `state`. Posts when the key is new or its state changed, and repeats an unchanged
   * state at most once per the alerter's repeat interval. Fire-and-forget: never throws.
   */
  alert(key: string, state: string, message: string): void;
  /** Forget `key`, so raising it again posts at once, and drop a post of it still being retried. */
  clear(key: string): void;
}

export interface AlerterOptions {
  webhook?: string;
  repeatMs: number;
  /** Waits before each retry of a failed post, the last repeating until it goes through. None: one attempt. */
  retryDelaysMs?: number[];
  /** Alerts still being retried before the oldest is dropped. */
  maxUndelivered?: number;
  now?: () => number;
  post?: (webhook: string | undefined, message: string) => Promise<boolean>;
  log?: Pick<typeof logger, "warn">;
}

/**
 * Deduplicating alert sink. A key counts as raised once its post went through: a refused or
 * timed-out post is retried until it does, so an alert raised once (a `Disputed` log, a parked
 * delivery) is not lost to a Discord outage; a newer raise of the key, or `clear`, takes its place.
 * State is in memory, so a restart forgets what was raised: whatever the caller re-checks and raises
 * again posts at once.
 */
export function createAlerter(opts: AlerterOptions): Alerter {
  const now = opts.now ?? Date.now;
  const post = opts.post ?? notifyDiscord;
  const log = opts.log ?? logger;
  const delays = opts.retryDelaysMs ?? RETRY_DELAYS_MS;
  const maxUndelivered = opts.maxUndelivered ?? MAX_UNDELIVERED;
  const raised = new Map<string, { state: string; at: number }>();
  /** The post under way for each key: a newer raise of the key, or `clear`, takes its place. */
  const posting = new Map<string, { state: string; token: object }>();

  async function deliver(key: string, state: string, message: string, token: object): Promise<void> {
    const current = () => posting.get(key)?.token === token;
    for (let attempt = 0; ; attempt++) {
      let ok = false;
      try {
        ok = await post(opts.webhook, message);
      } catch {
        // A post that throws is a failed post.
      }
      if (!current()) return;
      if (ok) {
        posting.delete(key);
        raised.set(key, { state, at: now() });
        if (attempt > 0) log.warn(`ALERT delivered after ${attempt + 1} attempts: ${key}`);
        return;
      }
      if (delays.length === 0) {
        posting.delete(key);
        log.warn(`ALERT not delivered: ${message}`);
        return;
      }
      const wait = delays[Math.min(attempt, delays.length - 1)];
      if (attempt === delays.length - 1) {
        log.warn(`ALERT not delivered after ${attempt + 1} attempts, retrying every ${wait / 60_000} min: ${message}`);
      }
      await sleep(wait, undefined, { ref: false });
      if (!current()) return;
    }
  }

  return {
    alert(key, state, message) {
      try {
        if (posting.get(key)?.state === state) return;
        const prev = raised.get(key);
        if (prev && prev.state === state && now() - prev.at < opts.repeatMs) return;
        if (!posting.has(key) && posting.size >= maxUndelivered) {
          const [oldest] = posting.keys();
          posting.delete(oldest);
          log.warn(`ALERT dropped undelivered, ${maxUndelivered} already waiting: ${oldest}`);
        }
        const token = {};
        posting.set(key, { state, token });
        log.warn(`ALERT ${message}`);
        void deliver(key, state, message, token).catch(() => {});
      } catch {
        // An alert must never take the caller down with it.
      }
    },
    clear(key) {
      raised.delete(key);
      posting.delete(key);
    },
  };
}
