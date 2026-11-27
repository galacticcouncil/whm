import { setTimeout as sleep } from "timers/promises";

/** Discord rejects content past 2000 characters. */
const MAX_CONTENT = 1900;

/** Waits before each retry of an alert whose post failed; the last repeats until Discord takes it. */
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000];

/** Alerts still being retried; past this many, the oldest is dropped with a log line. */
const MAX_UNDELIVERED = 500;

/** Discord caps an embed's title and description. */
const MAX_TITLE = 256;
const MAX_DESCRIPTION = 4000;

/** Where alert delivery reports itself — an app's logger, or the console. */
export interface AlertLog {
  warn(message: string): void;
  error(message: string): void;
}

/** How bad: the embed's colour. */
export type Level = "error" | "warn" | "ok";

/**
 * An alert as a Discord embed — a coloured card headed `{component} [{action}]`, a line of details,
 * then one `Label: value` line per field. `error` tags `@here`.
 */
export interface Embed {
  /** The app that raised it, e.g. `router`, `utxo relayer`. */
  component: string;
  /** What happened, lower case, e.g. `waiting to swap`. */
  action: string;
  level: Level;
  /** One sentence on what it means. */
  details?: string;
  /** Label and value, each on its own line; values may be markdown links — see `link`. */
  fields?: [string, string][];
}

/** A plain line of text, or an embed. */
export type Message = string | Embed;

const COLOR: Record<Level, number> = { error: 0xe5484d, warn: 0xf5a524, ok: 0x30a46c };

/**
 * A long id, shortened to its ends: `0xcddd98…fb4ef`.
 *
 * @param id The id.
 * @param head Characters kept at the start.
 * @param tail Characters kept at the end.
 * @returns The id, shortened when longer than both ends.
 */
export function short(id: string, head = 8, tail = 5): string {
  return id.length > head + tail + 1 ? `${id.slice(0, head)}…${id.slice(-tail)}` : id;
}

/**
 * A markdown link, for a field value: the text shown, the page a click opens.
 *
 * @param text What is shown.
 * @param url Where it leads; without one, the text alone.
 * @returns The markdown.
 */
export function link(text: string, url?: string): string {
  return url ? `[${text}](${url})` : text;
}

/**
 * The webhook body for a message.
 *
 * @param message A line of text or an embed.
 * @returns The JSON Discord takes.
 */
export function payload(message: Message): Record<string, unknown> {
  if (typeof message === "string") return { content: message.slice(0, MAX_CONTENT) };
  // A mention pings only from the content, never from inside an embed; nothing else may ping.
  const page = message.level === "error";
  const lines = (message.fields ?? []).map(([label, value]) => `**${label}:** ${value || "—"}`);
  const description = [message.details, message.details && lines.length ? "" : undefined, ...lines]
    .filter((l) => l !== undefined)
    .join("\n");
  return {
    content: page ? "@here" : undefined,
    allowed_mentions: { parse: page ? ["everyone"] : [] },
    embeds: [
      {
        title: `${message.component} [${message.action}]`.slice(0, MAX_TITLE),
        description: description.slice(0, MAX_DESCRIPTION) || undefined,
        color: COLOR[message.level],
      },
    ],
  };
}

/**
 * A message as one log line — links as their address, so the log keeps the full id.
 *
 * @param message A line of text or an embed.
 * @returns The text.
 */
export function text(message: Message): string {
  if (typeof message === "string") return message;
  const plain = (v: string) => v.replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$2");
  const fields = (message.fields ?? []).map(([label, value]) => `${label}: ${plain(value)}`);
  return [`${message.component} [${message.action}]`, message.details, ...fields].filter(Boolean).join(" — ");
}

/**
 * A duration, the way people read it.
 *
 * @param ms Milliseconds.
 * @returns E.g. `20h 53min`, `7min`.
 */
export function duration(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  return [d && `${d}d`, h && `${h}h`, (m || (!d && !h)) && `${m}min`].filter(Boolean).join(" ");
}

/**
 * Post one message to a Discord webhook. Never throws, and gives up after 10 s.
 *
 * @param webhook Webhook URL; nothing is sent without one.
 * @param message A line of text, or an embed; cut to what Discord accepts.
 * @param log Where a refused or failed post is reported.
 * @returns Whether Discord took it. True without a webhook: the log line is the alert.
 */
export async function notifyDiscord(webhook: string | undefined, message: Message, log: AlertLog = console): Promise<boolean> {
  if (!webhook) return true;
  try {
    const res = await globalThis.fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload(message)),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return true;
    log.error(`Discord notification refused: HTTP ${res.status}`);
  } catch (e) {
    log.error(`Failed to send Discord notification: ${(e as Error).message}`);
  }
  return false;
}

export interface Alerter {
  /**
   * Raise `key` in `state`. Posts when the key is new or its state changed, and repeats an unchanged
   * state at most once per the alerter's repeat interval. Fire-and-forget: never throws.
   */
  alert(key: string, state: string, message: Message): void;
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
  post?: (webhook: string | undefined, message: Message) => Promise<boolean>;
  log?: AlertLog;
}

/**
 * Deduplicating alert sink. A key counts as raised once its post went through: a refused or
 * timed-out post is retried until it does, so an alert raised once is not lost to a Discord outage;
 * a newer raise of the key, or `clear`, takes its place. State is in memory, so a restart forgets
 * what was raised: whatever the caller re-checks and raises again posts at once.
 *
 * @param opts The webhook, repeat interval and delivery policy.
 * @returns The alerter.
 */
export function createAlerter(opts: AlerterOptions): Alerter {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? console;
  const post = opts.post ?? ((webhook, message) => notifyDiscord(webhook, message, log));
  const delays = opts.retryDelaysMs ?? RETRY_DELAYS_MS;
  const maxUndelivered = opts.maxUndelivered ?? MAX_UNDELIVERED;
  const raised = new Map<string, { state: string; at: number }>();
  /** The post under way for each key: a newer raise of the key, or `clear`, takes its place. */
  const posting = new Map<string, { state: string; token: object }>();

  async function deliver(key: string, state: string, message: Message, token: object): Promise<void> {
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
        log.warn(`ALERT not delivered: ${text(message)}`);
        return;
      }
      const wait = delays[Math.min(attempt, delays.length - 1)];
      if (attempt === delays.length - 1) {
        log.warn(`ALERT not delivered after ${attempt + 1} attempts, retrying every ${wait / 60_000} min: ${text(message)}`);
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
        log.warn(`ALERT ${text(message)}`);
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
