import type { FastifyInstance } from "fastify";

import { ORACLE } from "../../deployments";

import { deliveredUpTo, overview, RANGES, series, updatesOf } from "./db";
import { feed, FEEDS } from "./feeds";

/**
 * Register the feeds read API: every feed at a glance, one feed's chart, and its updates.
 *
 * @param app Fastify instance.
 */
export function routes(app: FastifyInstance): void {
  // Each feed with where its updates land, so a card can draw its route — and how far that
  // destination is indexed, so a page can tell a dead feed from one not yet caught up with.
  const withRoute = async (feeds: typeof FEEDS) => {
    const [cards, upTo] = await Promise.all([overview(feeds), deliveredUpTo()]);
    return cards.map((c) => {
      const receiver = ORACLE[c.source].receiver;
      return { ...c, receiver: { ...receiver, indexedTo: upTo[receiver.chain] ?? null } };
    });
  };

  app.get("/api/feeds", async () => withRoute(FEEDS));

  app.get<{ Params: { id: string } }>("/api/feeds/:id", async (req, reply) => {
    const f = feed(req.params.id);
    if (!f) return reply.code(404).send({ error: "not found" });
    const [card] = await withRoute([f]);
    return { ...card, emitter: ORACLE[f.source].emitter };
  });

  app.get<{ Params: { id: string }; Querystring: { range?: string } }>(
    "/api/feeds/:id/series",
    async (req, reply) => {
      const f = feed(req.params.id);
      if (!f) return reply.code(404).send({ error: "not found" });
      const range = req.query.range && req.query.range in RANGES ? req.query.range : "7d";
      return series(f, range);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string; offset?: string } }>(
    "/api/feeds/:id/updates",
    async (req, reply) => {
      const f = feed(req.params.id);
      if (!f) return reply.code(404).send({ error: "not found" });
      return updatesOf(
        f,
        Math.min(Number(req.query.limit ?? 25), 200),
        Number(req.query.offset ?? 0),
      );
    },
  );
}
