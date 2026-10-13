import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";

import log from "./logger";

/** Port every app listens on. One container per app, so they never collide. */
export const port = Number(process.env.PORT ?? 8080);

export interface ServeOptions {
  /** App name — what `/api/status` reports, and what tells two containers apart in a log. */
  name: string;
  /** The app's own endpoints, conventionally under `/api/`. */
  routes: (app: FastifyInstance) => void;
  /** Merged into `/api/status` beside the fields every app reports. */
  status?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
}

/**
 * Boot an app's HTTP surface: liveness, status, and its own routes.
 *
 * @param opts What the app owns.
 * @returns The fastify instance, already listening.
 */
export async function serve(opts: ServeOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/status", async () => ({
    name: opts.name,
    uptime: process.uptime(),
    ...(await opts.status?.()),
  }));

  opts.routes(app);

  await app.register(cors, { origin: true });
  await app.listen({ port, host: "0.0.0.0" });
  log.info(`listening on :${port}`);
  return app;
}

/**
 * Run an app, or die loudly. Every entry point ends here.
 *
 * @param name App name, for the banner and the logs.
 * @param start What the app does.
 */
export function boot(name: string, start: () => Promise<void>): void {
  start().catch((err) => {
    log.error(`[${name}] fatal: ${(err as Error).stack ?? String(err)}`);
    process.exit(1);
  });
}
