import { Redis } from "ioredis";

import { createAlerter, Incidents, reprocessPage } from "@whm/common/discord";

import { banner } from "../../banner";
import log from "../../logger";
import { boot, serve } from "../../server";

import { alerts } from "./alerts";
import { APP_NAME, BALANCE_FLOOR, config, ONECLICK_ALERT_MS, PASS_ALERT_MS } from "./config";
import { botBalance, routerConfig } from "./near";
import { oneClickHealth } from "./oneclick";
import { Worker } from "./worker";

/**
 * The NEAR side of intents v2. For every set of terms scan lists, reads `A`'s balances and has the
 * router sign what is due — a swap through 1Click, a delivery, a refund — then sends it. The router
 * checks everything; this only decides when to ask, and asks once: a failure is alerted and waits
 * for a person.
 */
async function start(): Promise<void> {
  banner(APP_NAME);
  const rc = await routerConfig();
  log.info(`  router: ${config.router}, bot: ${config.account}, scan: ${config.scanApi}`);
  log.info(`  params: ${JSON.stringify(rc.params)}`);

  const redis = new Redis({ host: config.redis.host, port: config.redis.port, maxRetriesPerRequest: null });
  const alerter = createAlerter({ webhook: config.discordWebhook, repeatMs: 6 * 3_600_000, log });
  const incidents = new Incidents({ redis, prefix: config.redis.prefix, app: APP_NAME, alerter, publicUrl: config.publicUrl, log });
  const worker = new Worker(rc, incidents, redis, alerter);
  await worker.init();

  await serve({
    name: APP_NAME,
    routes: (app) => {
      app.get<{ Params: { id: string }; Querystring: { token?: string } }>("/reprocess/:id", async (req, reply) =>
        reply.type("text/html").send(reprocessPage(APP_NAME, req.params.id, req.query.token ?? "")),
      );
      app.post<{ Params: { id: string }; Body: { token?: string } }>("/reprocess/:id", async (req, reply) => {
        const result = await incidents.redeem(req.params.id, String(req.body?.token ?? ""));
        return result === "ok" ? { ok: true } : reply.code(result === "limited" ? 429 : 403).send(result);
      });
    },
    status: async () => ({ router: config.router, incidents: await incidents.list(), terms: Object.fromEntries(worker.seen) }),
  });

  let lastOk = Date.now();
  for (;;) {
    const ok = await worker.pass().then(
      () => true,
      (e) => (log.error(`pass: ${(e as Error).message}`), false),
    );
    if (ok) {
      lastOk = Date.now();
      alerter.clear("pass");
    } else if (Date.now() - lastOk > PASS_ALERT_MS) {
      alerter.alert("pass", "failing", alerts.passFailing(Date.now() - lastOk));
    }
    checkOneClick(alerter);
    await checkBalance(alerter);
    await new Promise((r) => setTimeout(r, config.tickMs));
  }
}

/**
 * Alert while every 1Click call has gone unanswered for `ONECLICK_ALERT_MS` — no quote, no swap.
 *
 * @param alerter The app's alerter.
 */
function checkOneClick(alerter: ReturnType<typeof createAlerter>): void {
  const since = oneClickHealth.failingSince;
  if (since === undefined) return alerter.clear("oneclick");
  if (Date.now() - since < ONECLICK_ALERT_MS) return;
  alerter.alert("oneclick", "down", alerts.oneClickDown(Date.now() - since, oneClickHealth.lastError));
}

/**
 * Alert while the bot's account is below `BALANCE_FLOOR`.
 *
 * @param alerter The app's alerter.
 */
async function checkBalance(alerter: ReturnType<typeof createAlerter>): Promise<void> {
  const balance = await botBalance().catch(() => undefined);
  if (balance === undefined) return;
  if (balance >= BALANCE_FLOOR) return alerter.clear("balance");
  alerter.alert("balance", "low", alerts.balanceLow(balance));
}

boot(APP_NAME, start);
