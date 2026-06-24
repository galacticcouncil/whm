import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { FastifyInstance } from "fastify";

import log from "../logger";
import type { Feature } from "../types";

// cwd-relative, like bjscan — `public/` is copied next to the bundle in the image.
const PUBLIC = resolve("public");

/** Read a public asset once at startup; null if it doesn't exist. */
function asset(file: string): string | null {
  const path = resolve(PUBLIC, file);
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

/**
 * Register the browser UI: a root landing (`/`) that links to each feature, a recent-transfers list
 * at `/<feature>` (from `public/<name>-list.html`) and a detail page at `/<feature>/:id` (from
 * `public/<name>.html`), plus the shared logo. Each feature page talks only to that feature's
 * `/api/<name>/*` endpoints and the feature-filtered `/api/events` SSE stream.
 *
 * @param app      fastify instance
 * @param features enabled features — each contributes `/<name>` (list) and `/<name>/:id` (detail)
 */
export function uiRoutes(app: FastifyInstance, features: Feature[]): void {
  const logoPath = resolve(PUBLIC, "logo.png");
  const logo = existsSync(logoPath) ? readFileSync(logoPath) : null;
  if (logo) {
    app.get("/logo.png", async (_req, reply) => {
      reply.type("image/png");
      return logo;
    });
  }

  const html = (page: string) => async (_req: unknown, reply: { type(t: string): void }) => {
    reply.type("text/html; charset=utf-8");
    return page;
  };

  const indexHtml = asset("index.html");
  if (indexHtml) {
    app.get("/", html(indexHtml));
    log.info("[ui] /");
  }

  for (const f of features) {
    const list = asset(`${f.name}-list.html`);
    if (list) {
      app.get(`/${f.name}`, html(list));
      log.info(`[ui] /${f.name}`);
    }
    const detail = asset(`${f.name}.html`);
    if (detail) {
      app.get(`/${f.name}/:id`, html(detail));
      log.info(`[ui] /${f.name}/:id`);
    }
    if (!list && !detail) {
      log.warn(`[ui] no public/${f.name}-list.html or ${f.name}.html — feature "${f.name}" has no UI`);
    }
  }
}
