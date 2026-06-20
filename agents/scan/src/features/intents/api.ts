import type { FastifyInstance } from "fastify";

import { getIntent, listIntents, type IntentState } from "./db";

/** Register the intents read API under /api/intents/*. */
export function routes(app: FastifyInstance): void {
  app.get<{
    Querystring: { state?: IntentState; address?: string; limit?: string; offset?: string };
  }>("/api/intents", async (req) => {
    const q = req.query;
    return listIntents({
      state: q.state,
      depositAddress: q.address,
      limit: Math.min(Number(q.limit ?? 100), 1000),
      offset: Number(q.offset ?? 0),
    });
  });

  app.get<{ Params: { id: string } }>("/api/intents/:id", async (req, reply) => {
    const row = await getIntent(req.params.id);
    if (!row) return reply.code(404).send({ error: "not found" });
    return row;
  });
}
