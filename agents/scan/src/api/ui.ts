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
 * Register the browser UI: a landing index, the shared logo, and one detail page per feature
 * served at `/<feature>/:id` (mirrors bjscan's per-transfer page). A feature gets a page iff
 * `public/<name>.html` exists; the page itself talks to that feature's `/api/<name>/*` endpoints
 * and the feature-filtered `/api/events` SSE stream.
 *
 * @param app      fastify instance
 * @param features enabled features — each with a `public/<name>.html` gets a `/<name>/:id` route
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

  const indexHtml = asset("index.html");
  if (indexHtml) {
    app.get("/", async (_req, reply) => {
      reply.type("text/html; charset=utf-8");
      return indexHtml;
    });
  }

  for (const f of features) {
    const html = asset(`${f.name}.html`);
    if (!html) {
      log.warn(`[ui] no public/${f.name}.html — feature "${f.name}" has no detail page`);
      continue;
    }
    app.get(`/${f.name}/:id`, async (_req, reply) => {
      reply.type("text/html; charset=utf-8");
      return html;
    });
    log.info(`[ui] /${f.name}/:id`);
  }
}
