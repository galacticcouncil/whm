import type { FastifyInstance } from "fastify";

import { WORMHOLE_CHAINS } from "../../chains";

import { getTransfer, listTransfers } from "./db";
import { TOKENS } from "./tokens";
import { ROUTES } from "./utxo/routes";

/** Hydration first — every transfer has it at one end — then by how much traffic each carries. */
const ORDER = [
  "hydration",
  "ethereum",
  "solana",
  "base",
  "robinhood",
  "hyperevm",
  "sui",
  "near",
  "zcash",
];
const rank = (c: string) => (ORDER.includes(c) ? ORDER.indexOf(c) : ORDER.length);

/** A comma-separated query parameter as its values, or undefined when absent. */
const list = (v?: string) => (v ? v.split(",").filter(Boolean) : undefined);

/**
 * Register the transfers read API: every rail in one list, each transfer whole, and what the list
 * can be filtered by.
 */
export function routes(app: FastifyInstance): void {
  app.get<{
    Querystring: {
      from?: string;
      to?: string;
      asset?: string;
      type?: string;
      status?: string;
      q?: string;
      limit?: string;
      offset?: string;
    };
  }>("/api/transfers", async (req) => {
    const q = req.query;
    return listTransfers({
      from: list(q.from),
      to: list(q.to),
      asset: list(q.asset),
      type: list(q.type),
      status: list(q.status),
      q: q.q?.trim() || undefined,
      limit: Math.min(Number(q.limit ?? 25), 1000),
      offset: Number(q.offset ?? 0),
    });
  });

  // The filters' options, from the same registries the rows are built from — never a list of its own.
  app.get("/api/filters", async () => ({
    chains: [...new Set([...Object.values(WORMHOLE_CHAINS), ...ROUTES.map((r) => r.chain)])].sort(
      (a, b) => rank(a) - rank(b),
    ),
    assets: TOKENS,
    types: ["transfer", "deposit", "withdraw", "intent", "basejump"],
    statuses: ["pending", "held", "completed", "failed"],
  }));

  app.get<{ Params: { id: string } }>("/api/transfers/:id", async (req, reply) => {
    const t = await getTransfer(req.params.id);
    if (!t) return reply.code(404).send({ error: "not found" });
    return t;
  });
}
