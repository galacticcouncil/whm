import type { FastifyInstance } from "fastify";

import { getOrder, listOrders, listTerms } from "./db";

/**
 * Register the intents v2 read API.
 *
 * @param app The domain's fastify instance.
 */
export function routes(app: FastifyInstance): void {
  app.get<{
    Querystring: {
      state?: string;
      authPath?: string;
      publishedAfter?: string;
      address?: string;
      limit?: string;
      offset?: string;
    };
  }>("/api/orders", async (req) => {
    const q = req.query;
    return listOrders({
      state: q.state ? q.state.split(",").filter(Boolean) : undefined,
      authPath: q.authPath,
      publishedAfter: q.publishedAfter !== undefined ? Number(q.publishedAfter) : undefined,
      address: q.address,
      limit: Math.min(Number(q.limit ?? 100), 1000),
      offset: Number(q.offset ?? 0),
    });
  });

  app.get<{ Params: { seq: string } }>("/api/orders/:seq", async (req, reply) => {
    const row = await getOrder(req.params.seq);
    if (!row) return reply.code(404).send({ error: "not found" });
    return row;
  });

  app.get<{ Querystring: { deadlineAfter?: string } }>("/api/terms", async (req, reply) => {
    const after = Number(req.query.deadlineAfter);
    if (!Number.isSafeInteger(after)) {
      return reply.code(400).send({ error: "query param `deadlineAfter` (unix seconds) is required" });
    }
    return listTerms(after);
  });
}
