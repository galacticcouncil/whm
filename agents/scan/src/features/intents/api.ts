import type { FastifyInstance } from "fastify";

import { getIntent, listIntents, type IntentState } from "./db";
import { tokenMetadata } from "./metadata";

/** Register the intents read API under /api/intents/*. */
export function routes(app: FastifyInstance): void {
  // Asset metadata (Hydration source assets + 1Click destination assets) for formatting amounts/
  // symbols in the UI. Cached server-side, so this is cheap to poll. Static path, registered before
  // `/:id` so it isn't captured as an intent id.
  app.get("/api/intents/tokens", async () => tokenMetadata());

  app.get<{
    Querystring: { state?: IntentState; address?: string; limit?: string; offset?: string };
  }>("/api/intents", async (req) => {
    const q = req.query;
    return listIntents({
      state: q.state,
      address: q.address,
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
