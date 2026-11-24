import type { FastifyInstance } from "fastify";

import { hydrationAssets } from "../intents/metadata";

import { hydrationAssetId } from "./assets";
import { getOrder, getTrade, listOrders, listTerms, listTrades, listUtxoPayouts } from "./db";
import { held } from "./held";

/**
 * A row with the Hydration asset it sold resolved: `asset_in` as the asset id where the address ICE
 * named resolves to one (else that address), and `asset_in_meta` its symbol, decimals and icon.
 *
 * @param row An order or trade row.
 * @returns The row, resolved.
 */
async function withAsset<T extends Record<string, unknown>>(row: T): Promise<T> {
  if (typeof row.asset_in !== "string") return { ...row, asset_in_meta: null };
  const id = (await hydrationAssetId(row.asset_in)) ?? row.asset_in;
  const meta = typeof id === "number" ? ((await hydrationAssets())[id] ?? null) : null;
  return { ...row, asset_in: id, asset_in_meta: meta };
}

/**
 * Every row of a page, resolved as {@link withAsset}.
 *
 * @param page A page of rows.
 * @returns The page, resolved.
 */
async function withAssets<T extends Record<string, unknown>>(page: { items: T[]; total: number }) {
  return { ...page, items: await Promise.all(page.items.map(withAsset)) };
}

/**
 * Register the intents v2 read API: trades and their orders for the pages, the terms in play for the
 * router bot, the deliveries on a UTXO route for the UTXO relayer. The UI serves it under `/api/v2`.
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
    return withAssets(await listOrders({
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
    return withAsset(row);
  });

  app.get<{ Querystring: { deadlineAfter?: string } }>("/api/terms", async (req, reply) => {
    const after = Number(req.query.deadlineAfter);
    if (!Number.isSafeInteger(after)) {
      return reply.code(400).send({ error: "query param `deadlineAfter` (unix seconds) is required" });
    }
    return listTerms(after);
  });

  app.get<{ Querystring: { utxo?: string; after?: string; limit?: string } }>("/api/payouts", async (req, reply) => {
    const after = Number(req.query.after);
    if (req.query.utxo !== "true" || !Number.isSafeInteger(after)) {
      return reply.code(400).send({ error: "query params `utxo=true` and `after` (unix ms) are required" });
    }
    return listUtxoPayouts(after, Math.min(Number(req.query.limit ?? 500), 1000));
  });

  app.get<{ Querystring: { status?: string; address?: string; limit?: string; offset?: string } }>(
    "/api/trades",
    async (req) => {
      const q = req.query;
      return withAssets(
        await listTrades({
          status: q.status ? q.status.split(",").filter(Boolean) : undefined,
          address: q.address,
          limit: Math.min(Number(q.limit ?? 100), 1000),
          offset: Number(q.offset ?? 0),
        }),
      );
    },
  );

  app.get<{ Params: { authPath: string } }>("/api/trades/:authPath", async (req, reply) => {
    const t = await getTrade(req.params.authPath);
    if (!t) return reply.code(404).send({ error: "not found" });
    // What A holds of the destination: swapped, not yet paid out. Read on every request, so a page
    // that refetches after a swap sees it — and a trade still holding output is not completed yet.
    const dest = t.trade.destination_asset;
    const a = typeof dest === "string" ? await held(String(t.trade.auth_path), dest) : null;
    const status = t.trade.status === "completed" && BigInt(a?.amount ?? 0) > 0n ? "pending" : t.trade.status;
    return {
      ...t,
      trade: { ...(await withAsset(t.trade)), status, account: a?.account ?? null, held: a?.amount ?? null },
      orders: await Promise.all(t.orders.map(withAsset)),
    };
  });
}
