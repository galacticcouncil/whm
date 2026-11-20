import type { FastifyInstance } from "fastify";

import { hydrationAssets } from "../intents/metadata";

import { hydrationAssetId } from "./assets";
import { getOrder, getPlan, listOrders, listPayouts, listPlans, listTerms } from "./db";

/**
 * A row with its `asset_in` as the Hydration asset id the pages look tokens up by, where the address
 * ICE named resolves to one; else as that address.
 *
 * @param row An order or plan row.
 * @returns The row, resolved.
 */
async function withAssetId<T extends Record<string, unknown>>(row: T): Promise<T> {
  if (typeof row.asset_in !== "string") return row;
  return { ...row, asset_in: (await hydrationAssetId(row.asset_in)) ?? row.asset_in };
}

/**
 * Every row of a page, resolved as {@link withAssetId}.
 *
 * @param page A page of rows.
 * @returns The page, resolved.
 */
async function withAssetIds<T extends Record<string, unknown>>(page: { items: T[]; total: number }) {
  return { ...page, items: await Promise.all(page.items.map(withAssetId)) };
}

/**
 * Register the intents v2 read API.
 *
 * @param app The domain's fastify instance.
 */
export function routes(app: FastifyInstance): void {
  // Symbols and decimals of the Hydration assets an ICE order sells — read once, at the first call.
  // Shared with the v1 intents app's metadata, which reads the same registry.
  app.get("/api/tokens", async () => ({ hydration: await hydrationAssets() }));

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
    return withAssetIds(await listOrders({
      state: q.state ? q.state.split(",").filter(Boolean) : undefined,
      authPath: q.authPath,
      publishedAfter: q.publishedAfter !== undefined ? Number(q.publishedAfter) : undefined,
      address: q.address,
      limit: Math.min(Number(q.limit ?? 100), 1000),
      offset: Number(q.offset ?? 0),
    }));
  });

  app.get<{ Params: { seq: string } }>("/api/orders/:seq", async (req, reply) => {
    const row = await getOrder(req.params.seq);
    if (!row) return reply.code(404).send({ error: "not found" });
    return withAssetId(row);
  });

  app.get<{ Querystring: { deadlineAfter?: string } }>("/api/terms", async (req, reply) => {
    const after = Number(req.query.deadlineAfter);
    if (!Number.isSafeInteger(after)) {
      return reply.code(400).send({ error: "query param `deadlineAfter` (unix seconds) is required" });
    }
    return listTerms(after);
  });

  app.get<{ Querystring: { authPath?: string } }>("/api/payouts", async (req, reply) => {
    if (!req.query.authPath) return reply.code(400).send({ error: "query param `authPath` is required" });
    return listPayouts(req.query.authPath);
  });

  app.get<{ Querystring: { status?: string; address?: string; limit?: string; offset?: string } }>(
    "/api/plans",
    async (req) => {
      const q = req.query;
      return withAssetIds(
        await listPlans({
          status: q.status ? q.status.split(",").filter(Boolean) : undefined,
          address: q.address,
          limit: Math.min(Number(q.limit ?? 100), 1000),
          offset: Number(q.offset ?? 0),
        }),
      );
    },
  );

  app.get<{ Params: { authPath: string } }>("/api/plans/:authPath", async (req, reply) => {
    const plan = await getPlan(req.params.authPath);
    if (!plan) return reply.code(404).send({ error: "not found" });
    return { ...plan, plan: await withAssetId(plan.plan), orders: await Promise.all(plan.orders.map(withAssetId)) };
  });
}
