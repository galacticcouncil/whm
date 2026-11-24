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
};
