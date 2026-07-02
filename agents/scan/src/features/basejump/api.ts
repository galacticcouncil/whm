import type { FastifyInstance } from "fastify";

import { addressFilter, getTransfer, listTransfers, type TransferState } from "./db";

/** Register the Basejump read API under /api/basejump/*. */
export function routes(app: FastifyInstance): void {
  app.get<{
    Querystring: {
      state?: TransferState;
      address?: string;
      asset?: string;
      limit?: string;
      offset?: string;
    };
  }>("/api/basejump/transfers", async (req) => {
    const q = req.query;
    return listTransfers({
      state: q.state,
      address: q.address ? addressFilter(q.address) : undefined,
      asset: q.asset,
      limit: Math.min(Number(q.limit ?? 100), 1000),
      offset: Number(q.offset ?? 0),
    });
  });

  app.get<{ Params: { id: string } }>("/api/basejump/transfers/:id", async (req, reply) => {
    const row = await getTransfer(req.params.id);
    if (!row) return reply.code(404).send({ error: "not found" });
    return row;
  });
}
