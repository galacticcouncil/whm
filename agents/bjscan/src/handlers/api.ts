import type { EvmWatcher } from "../watchers/evm.js";
import type { SubstrateWatcher } from "../watchers/substrate.js";
import { app } from "../endpoints.js";
import {
  getTransfer,
  listTransfers,
  loadCursor,
  stateCounts,
  type TransferState,
} from "../db.js";
import { subscribe } from "../subscribers.js";
import { source, destination } from "../config.js";

export default function apiHandler(base: EvmWatcher, hydration: SubstrateWatcher): void {
  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/status", async () => {
    const [srcCursor, dstCursor, srcSafe, dstSafe, counts] = await Promise.all([
      loadCursor(source.name),
      loadCursor(destination.name),
      base.latestSafe().catch(() => null),
      hydration.latestSafe().catch(() => null),
      stateCounts(),
    ]);
    return {
      uptime: process.uptime(),
      chains: {
        [source.name]: {
          contract: source.contract,
          chainId: source.chain.id,
          cursor: srcCursor?.toString() ?? null,
          safe: srcSafe?.toString() ?? null,
        },
        [destination.name]: {
          contract: destination.contract,
          chainId: destination.chainId,
          cursor: dstCursor?.toString() ?? null,
          safe: dstSafe?.toString() ?? null,
        },
      },
      counts,
      total: counts.initiated + counts.completed + counts.queued + counts.fulfilled,
    };
  });

  app.get<{
    Querystring: {
      state?: TransferState;
      recipient?: string;
      asset?: string;
      limit?: string;
      offset?: string;
    };
  }>("/api/transfers", async (req) => {
    const q = req.query;
    return listTransfers({
      state: q.state,
      recipient: q.recipient,
      asset: q.asset,
      limit: Math.min(Number(q.limit ?? 100), 1000),
      offset: Number(q.offset ?? 0),
    });
  });

  app.get<{ Params: { id: string } }>("/api/transfers/:id", async (req, reply) => {
    const row = await getTransfer(req.params.id);
    if (!row) return reply.code(404).send({ error: "not found" });
    return row;
  });

  app.get("/api/events", (req, reply) => {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    });
    raw.write("retry: 3000\n\n");
    raw.write(": connected\n\n");

    const unsubscribe = subscribe((u) => {
      raw.write(`event: ${u.kind}\ndata: ${JSON.stringify(u)}\n\n`);
    });
    const heartbeat = setInterval(() => raw.write(": heartbeat\n\n"), 15_000);

    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
      raw.end();
    };
    req.raw.on("close", close);
    req.raw.on("error", close);
  });
}
