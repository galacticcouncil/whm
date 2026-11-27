import { Readable } from "node:stream";

import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";

import { banner } from "../banner";
import { pages } from "../flow/pages";
import log from "../logger";

const NAME = "ui";

/**
 * The apps behind the pages. They stay public on their own hosts with their own paths — their read and
 * subscribe APIs are for anyone — and this only puts every page on one origin. Defaults are the apps'
 * compose ports on this host.
 */
const APPS: Record<string, string> = {
  transfers: process.env.TRANSFERS_API || "http://localhost:8081",
  v1: process.env.ORDERS_API || "http://localhost:8080",
  v2: process.env.ORDERS_V2_API || "http://localhost:8084",
  feeds: process.env.FEEDS_API || "http://localhost:8082",
};

/** Which app publishes each live flow: `/api/events` is one stream for every page, routed by its flows. */
const FLOW_APP: Record<string, string> = {
  ntt: "transfers",
  utxo: "transfers",
  "utxo-signs": "transfers",
  basejump: "transfers",
  psm: "transfers",
  orders: "v1",
  "orders-v2": "v2",
  "payouts-v2": "v2",
  oracle: "feeds",
};

/** Response headers worth passing through; hop-by-hop ones are the proxy's own. */
const PASS = ["content-type", "cache-control", "x-accel-buffering"];

/**
 * One UI over the apps: Transfers, Orders (v1), Trades and Orders (v2) and Feeds. The pages call one
 * API on this origin, and each path goes to the app that serves it:
 *
 *   /api/transfers…           → transfers, as is        /api/transfers/filters → transfers /api/filters
 *   /api/feeds…               → feeds, as is
 *   /api/v1/<path>            → intents v1 /api/<path>
 *   /api/v2/<path>            → intents v2 /api/<path>  (trades, orders)
 *   /api/events?flow=…        → the app whose flows they are
 *
 * Holds no state and touches no database — every byte it serves is a page, or an app's answer passed
 * through, the live streams included.
 */
async function main(): Promise<void> {
  banner(NAME);
  const app = Fastify({ logger: false });

  app.get("/api/health", async () => ({ ok: true, apps: APPS }));
  app.get("/", async (_req, reply) => reply.redirect("/transfers"));

  /**
   * Pass one request to an app, streamed: an event stream stays open for as long as the page does,
   * and closes upstream when the page goes.
   *
   * @param req The page's request — its query string is passed on.
   * @param reply Where the app's answer goes.
   * @param name The app.
   * @param path The app's own path.
   */
  const forward = async (req: FastifyRequest, reply: FastifyReply, name: string, path: string) => {
    const base = APPS[name]!;
    const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const abort = new AbortController();
    req.raw.on("close", () => abort.abort());
    let res: Response;
    try {
      res = await fetch(`${base}${path}${query}`, { signal: abort.signal });
    } catch (e) {
      log.warn(`[ui] ${name}: ${(e as Error).message}`);
      return reply.code(502).send({ error: `${name} unavailable` });
    }
    reply.code(res.status);
    for (const h of PASS) {
      const v = res.headers.get(h);
      if (v) reply.header(h, v);
    }
    return res.body ? reply.send(Readable.fromWeb(res.body as never)) : reply.send();
  };

  type Rest = { Params: { "*": string } };

  app.get<{ Querystring: { flow?: string } }>("/api/events", async (req, reply) => {
    const flows = (req.query.flow ?? "").split(",").filter(Boolean);
    const name = flows.length ? FLOW_APP[flows[0]!] : undefined;
    if (!name || flows.some((f) => FLOW_APP[f] !== name)) {
      return reply.code(400).send({ error: "`flow` must name flows of one app" });
    }
    return forward(req, reply, name, "/api/events");
  });

  app.get("/api/transfers/filters", (req, reply) => forward(req, reply, "transfers", "/api/filters"));
  app.get("/api/transfers", (req, reply) => forward(req, reply, "transfers", "/api/transfers"));
  app.get<Rest>("/api/transfers/*", (req, reply) => forward(req, reply, "transfers", `/api/transfers/${req.params["*"]}`));
  app.get("/api/feeds", (req, reply) => forward(req, reply, "feeds", "/api/feeds"));
  app.get<Rest>("/api/feeds/*", (req, reply) => forward(req, reply, "feeds", `/api/feeds/${req.params["*"]}`));
  app.get<Rest>("/api/v1/*", (req, reply) => forward(req, reply, "v1", `/api/${req.params["*"]}`));
  app.get<Rest>("/api/v2/*", (req, reply) => forward(req, reply, "v2", `/api/${req.params["*"]}`));

  pages(app, NAME);

  const port = Number(process.env.PORT ?? 8080);
  await app.listen({ port, host: "0.0.0.0" });
  for (const [name, url] of Object.entries(APPS)) log.info(`  ${name} -> ${url}`);
  log.info(`listening on :${port}`);
}

main().catch((err) => {
  log.error("fatal:", err);
  process.exit(1);
});
