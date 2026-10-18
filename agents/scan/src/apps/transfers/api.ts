import type { FastifyInstance } from "fastify";

import { getTransfer, listTransfers } from "./db";

/** Register the transfers read API: every rail in one list, and each transfer whole. */
export function routes(app: FastifyInstance): void {
  app.get<{
    Querystring: {
      type?: string;
      status?: string;
      address?: string;
      limit?: string;
      offset?: string;
    };
  }>("/api/transfers", async (req) => {
    const q = req.query;
    return listTransfers({
      type: q.type,
      status: q.status,
      address: q.address,
      limit: Math.min(Number(q.limit ?? 100), 1000),
      offset: Number(q.offset ?? 0),
    });
  });

  app.get<{ Params: { id: string } }>("/api/transfers/:id", async (req, reply) => {
    const t = await getTransfer(req.params.id);
    if (!t) return reply.code(404).send({ error: "not found" });
    return t;
  });
}
