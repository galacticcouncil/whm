import { Readable } from "node:stream";

import Fastify from "fastify";

import { banner } from "../banner";
import { pages } from "../flow/pages";
import log from "../logger";

const NAME = "ui";

/**
 * Each section's app, by the prefix its pages call it under. The apps stay public on their own
 * ports — their read and subscribe APIs are for anyone — and this only puts every page on one
 * origin. Defaults are the apps' compose ports on this host.
 */
const UPSTREAMS: Record<string, string> = {
  transfers: process.env.TRANSFERS_API || "http://localhost:8081",
  orders: process.env.ORDERS_API || "http://localhost:8080",
  feeds: process.env.FEEDS_API || "http://localhost:8082",
};

/** Response headers worth passing through; hop-by-hop ones are the proxy's own. */
const PASS = ["content-type", "cache-control", "x-accel-buffering"];

/**
 * One UI over the three apps: Transfers, Orders and Feeds, each section's pages calling its own
 * app through `/api/<section>/…`. Holds no state and touches no database — every byte it serves
 * is a page, or an app's answer passed through, the live streams included.
 */
async function main(): Promise<void> {
  banner(NAME);
  const app = Fastify({ logger: false });

  app.get("/api/health", async () => ({ ok: true, upstreams: UPSTREAMS }));
  app.get("/", async (_req, reply) => reply.redirect("/transfers"));

  // `/api/<section>/<path>` → `<app>/api/<path>`, streamed: an event stream stays open for as long
  // as the page does, and closes upstream when the page goes.
  app.get<{ Params: { section: string; "*": string } }>(
    "/api/:section/*",
    async (req, reply) => {
      const base = UPSTREAMS[req.params.section];
      if (!base) return reply.code(404).send({ error: `no section ${req.params.section}` });
      const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
      const abort = new AbortController();
      req.raw.on("close", () => abort.abort());
      let res: Response;
      try {
        res = await fetch(`${base}/api/${req.params["*"]}${query}`, { signal: abort.signal });
      } catch (e) {
        log.warn(`[ui] ${req.params.section}: ${(e as Error).message}`);
        return reply.code(502).send({ error: `${req.params.section} unavailable` });
      }
      reply.code(res.status);
      for (const h of PASS) {
        const v = res.headers.get(h);
        if (v) reply.header(h, v);
      }
      return res.body ? reply.send(Readable.fromWeb(res.body as never)) : reply.send();
    },
  );

  pages(app, NAME);

  const port = Number(process.env.PORT ?? 8080);
  await app.listen({ port, host: "0.0.0.0" });
  for (const [section, url] of Object.entries(UPSTREAMS)) log.info(`  /${section} -> ${url}`);
  log.info(`listening on :${port}`);
}

main().catch((err) => {
  log.error("fatal:", err);
  process.exit(1);
});
