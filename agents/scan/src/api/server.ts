import cors from "@fastify/cors";
import Fastify from "fastify";

import log from "../logger";
import { chains, port } from "../config";
import { loadCursor } from "../db";
import { subscribe } from "../subscribers";
import type { Feature } from "../types";

export const app = Fastify({ logger: false });

/** Minimal shape the status endpoint needs from a watcher. */
interface WatcherLike {
  cfg: { name: string };
  latestSafe(): Promise<bigint>;
}

/**
 * Register the cross-feature core routes: liveness, per-chain + per-feature status, and the
 * feature-tagged SSE stream (optionally filtered by `?feature=`).
 *
 * @param features enabled features (for status counts)
 * @param watchers running watchers (for per-chain safe height)
 */
export function coreRoutes(features: Feature[], watchers: WatcherLike[]): void {
  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/status", async () => {
    const chainEntries = await Promise.all(
      Object.values(chains).map(async (c) => {
        const w = watchers.find((x) => x.cfg.name === c.name);
        const [cursor, safe] = await Promise.all([
          loadCursor(c.name),
          w ? w.latestSafe().catch(() => null) : Promise.resolve(null),
        ]);
        const chainId = c.kind === "evm" ? c.chain.id : c.chainId;
        return [
          c.name,
          {
            kind: c.kind,
            chainId,
            cursor: cursor?.toString() ?? null,
            safe: safe?.toString() ?? null,
          },
        ] as const;
      }),
    );

    const featureEntries = await Promise.all(
      features.map(async (f) => [f.name, await f.counts()] as const),
    );

    return {
      uptime: process.uptime(),
      chains: Object.fromEntries(chainEntries),
      features: Object.fromEntries(featureEntries),
    };
  });

  app.get<{ Querystring: { feature?: string } }>("/api/events", (req, reply) => {
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

    const wantFeature = req.query.feature;
    const unsubscribe = subscribe((u) => {
      if (wantFeature && u.feature !== wantFeature) return;
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

export async function start(): Promise<void> {
  await app.register(cors, { origin: true });
  await app.listen({ port, host: "0.0.0.0" });
  log.info(`listening on :${port}`);
}
