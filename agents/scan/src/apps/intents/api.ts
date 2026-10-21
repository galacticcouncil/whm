import type { FastifyInstance } from "fastify";

import { getOrder, listOrders } from "./db";
import { tokenMetadata } from "./metadata";

/** Register the intents read API. */
export function routes(app: FastifyInstance): void {
  // Static path, registered before `/:id` so a sequence lookup never captures it.
  app.get("/api/tokens", async () => tokenMetadata());

  app.get<{
    Querystring: { state?: string; address?: string; limit?: string; offset?: string };
  }>("/api/orders", async (req) => {
    const q = req.query;
    return listOrders({
      state: q.state ? q.state.split(",").filter(Boolean) : undefined,
      address: q.address,
      limit: Math.min(Number(q.limit ?? 100), 1000),
      offset: Number(q.offset ?? 0),
    });
  });

  app.get<{ Params: { id: string } }>("/api/orders/:id", async (req, reply) => {
    const row = await getOrder(req.params.id);
    if (!row) return reply.code(404).send({ error: "not found" });
    return row;
  });
}
