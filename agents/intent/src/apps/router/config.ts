import { required } from "../../env";

export const APP_NAME = "router";

export const config = {
  /** The scan `intents-v2` app — where the terms and their orders come from. */
  scanApi: required("SCAN_API").replace(/\/$/, ""),
  rpcNear: required("RPC_NEAR"),
  /** The `IntentRouter` account. */
  router: required("ROUTER"),
  /** The bot's NEAR account. Its key must be full-access: every router call attaches 1 yocto. */
  account: required("NEAR_ACCOUNT"),
  privateKey: required("NEAR_PRIVKEY"),
  /** 1Click partner key — quotes it gets must be signed by a key in the router's `quote_keys`. */
  oneClickKey: required("ONECLICK_KEY"),
  /** How long past their deadline terms stay listed, so a bot that was down still pays them out. */
  graceDays: Number(process.env.GRACE_DAYS ?? 30),
  tickMs: Number(process.env.TICK_MS ?? 30_000),
  /** Where failed attempts and filled orders are kept, so a restart does not pay for them again. */
  redis: {
    host: process.env.REDIS_HOST ?? "localhost",
    port: Number(process.env.REDIS_PORT ?? 6379),
    /** LOAD-BEARING — every key starts with it; changing it forgets the open incidents. */
    prefix: process.env.REDIS_PREFIX ?? "router",
  },
  /** Alerts — failed attempts, a failing pass, a low balance. Unset: the log is the alert. */
  discordWebhook: process.env.DISCORD_WEBHOOK_URL,
  /** Where this app's `/reprocess` page is reachable from outside, for the alerts' links. */
  publicUrl: process.env.PUBLIC_URL,
  /** Scan's public address, e.g. `https://scan.play.hydration.cloud` — the alerts link trades to it. */
  scanUrl: process.env.SCAN_URL?.replace(/\/$/, ""),
};

/** Below this the bot account's NEAR is alerted, yocto — about 270 signatures. */
export const BALANCE_FLOOR = 10n ** 24n;

/** A pass failing this long — scan unreachable, NEAR RPC down — is alerted. */
export const PASS_ALERT_MS = 10 * 60_000;

/** An order forwarded this long without `A` credited is alerted — its ETH sits with 1Click/POA. */
export const CREDIT_ALERT_MS = 30 * 60_000;

/** An order credited and still not swapped this long after its forward is alerted. */
export const SWAP_ALERT_MS = 60 * 60_000;

/** Terms this close to their deadline with ETH still in `A` are alerted — it will be refunded. */
export const REFUND_ALERT_MS = 60 * 60_000;

/** 1Click failing — no answer, 5xx, 429 — this long is alerted. */
export const ONECLICK_ALERT_MS = 10 * 60_000;

/** A send that never reached a decision is resent this many times, this far apart, in the same pass. */
export const SEND_ATTEMPTS = 3;
export const SEND_RETRY_MS = 3_000;
