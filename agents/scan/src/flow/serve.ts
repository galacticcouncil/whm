import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";

import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";

import { CHAINS, chainId } from "../chains";
import { chainCursors, listenRows, pool, readerState } from "../db";
import { WATCH } from "../watch";
import log from "../logger";
import { port } from "../config";
import type { Flow } from "../types";
import { validLegs } from "./schema";
import { broadcast, subscribe } from "./subscribers";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/** The part of a watcher /api/status needs; only ingest has any. */
export interface WatcherLike {
  cfg: { name: string };
  latestSafe(): Promise<bigint>;
}

export interface ServeOptions {
  /** Domain name — the reader's identity, and the directory its pages come from. */
  name: string;
  flows: Flow[];
  /** The domain's own endpoints, conventionally under `/api/`. */
  routes?: (app: FastifyInstance) => void;
  watchers?: WatcherLike[];
  /**
   * Flows another process owns whose changes this domain's pages also follow — relayed onto its own
   * stream as `{ id, state }`, for the page to refetch.
   */
  follow?: string[];
}

/**
 * Per-state row counts for one flow, orphans excluded.
 *
 * @param f The flow.
 */
export async function stateCounts(f: Flow): Promise<Record<string, number>> {
  const r = await pool.query(
    `SELECT state, COUNT(*)::int AS n FROM ${f.table} WHERE ${validLegs(f)} GROUP BY state`,
  );
  const out: Record<string, number> = Object.fromEntries(Object.keys(f.states).map((s) => [s, 0]));
  for (const row of r.rows) out[row.state] = row.n;
  return out;
}

/**
 * Boot a domain's HTTP surface: liveness, status, the live stream, its pages, and its own routes.
 *
 * @param opts What the domain owns.
 * @returns The fastify instance, already listening.
 */
export async function serve(opts: ServeOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/status", async () => {
    // Every chain in the watch list, not just the ones this process has an endpoint for — a reader
    // covers them all, and `rpc: false` is what says who is able to ingest.
    const names = [...new Set(WATCH.map((w) => w.chain))];
    const chains = await Promise.all(
      names.map(async (name) => {
        const c = CHAINS[name];
        const w = opts.watchers?.find((x) => x.cfg.name === name);
        const [roles, safe] = await Promise.all([
          chainCursors(name),
          w ? w.latestSafe().catch(() => null) : Promise.resolve(null),
        ]);
        return [
          name,
          {
            rpc: Boolean(c),
            kind: c?.kind ?? null,
            chainId: c ? chainId(c) : null,
            wormholeId: c?.wormholeId ?? null,
            safe: safe?.toString() ?? null,
            roles,
          },
        ] as const;
      }),
    );
    const flows = await Promise.all(
      opts.flows.map(async (f) => [f.name, await stateCounts(f)] as const),
    );
    return {
      name: opts.name,
      uptime: process.uptime(),
      reader: await readerState(opts.name),
      chains: Object.fromEntries(chains),
      flows: Object.fromEntries(flows),
    };
  });

  if (opts.follow?.length) {
    const follow = new Set(opts.follow);
    listenRows((n) => {
      if (!follow.has(n.flow)) return;
      broadcast({
        flow: n.flow,
        kind: n.kind,
        record: { id: n.id, state: n.state },
        previousState: n.previousState,
      });
    });
  }

  // Server-sent row changes. `?flow=` narrows a page to the tables it renders, comma-separated.
  app.get<{ Querystring: { flow?: string } }>("/api/events", (req, reply) => {
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

    const want = req.query.flow ? new Set(req.query.flow.split(",")) : null;
    const unsubscribe = subscribe((u) => {
      if (want && !want.has(u.flow)) return;
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

  opts.routes?.(app);
  pages(app, opts.name);

  await app.register(cors, { origin: true });
  await app.listen({ port, host: "0.0.0.0" });
  log.info(`listening on :${port}`);
  return app;
}

/**
 * Serve the domain's static pages, read once at boot.
 *
 * Pages live in `public/<domain>/` so each container ships only its own, and the styling they share
 * lives once in `public/shared/`. `index.html` is the root; every other page answers both a list
 * path and a detail path, and decides between them client-side.
 *
 * @param app Fastify instance.
 * @param name Domain name — cwd-relative, beside the bundle.
 */
function pages(app: FastifyInstance, name: string): void {
  serveDir(app, resolve("public", "shared"), "/shared");

  const dir = resolve("public", name);
  if (!existsSync(dir)) {
    log.warn(`[ui] no public/${name} — this domain serves no pages`);
    return;
  }

  for (const file of readdirSync(dir)) {
    const send = asset(dir, file);
    if (!send) continue;
    if (!file.endsWith(".html")) {
      app.get(`/${file}`, send);
      continue;
    }
    const page = file.slice(0, -5);
    if (page === "index") {
      app.get("/", send);
      log.info("[ui] /");
      continue;
    }
    app.get(`/${page}`, send);
    app.get(`/${page}/:id`, send);
    log.info(`[ui] /${page}, /${page}/:id`);
  }
}

/** Serve every recognised file in a directory under a prefix, verbatim. */
function serveDir(app: FastifyInstance, dir: string, prefix: string): void {
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) {
    const send = asset(dir, file);
    if (send) app.get(`${prefix}/${file}`, send);
  }
}

/**
 * A handler returning one file, read at boot.
 *
 * @returns null for a type we do not serve.
 */
function asset(dir: string, file: string) {
  const type = MIME[extname(file)];
  if (!type) return null;
  const path = resolve(dir, file);
  const body = type.startsWith("image/") ? readFileSync(path) : readFileSync(path, "utf-8");
  return async (_req: unknown, reply: { type(t: string): void }) => {
    reply.type(type);
    return body;
  };
}
