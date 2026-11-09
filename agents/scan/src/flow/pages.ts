import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";

import type { FastifyInstance } from "fastify";

import log from "../logger";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** Served as bytes, not text. */
const BINARY = /^(image|font)\//;

/**
 * Serve a site's static pages, read once at boot — today only the UI's.
 *
 * Pages live in `public/<name>/`, and the styling and helpers they share in `public/shared/`.
 * `index.html` is the root; every other page answers both a list path and a detail path, and
 * decides between them client-side.
 *
 * @param app Fastify instance.
 * @param name The site — cwd-relative, beside the bundle.
 */
export function pages(app: FastifyInstance, name: string): void {
  serveDir(app, resolve("public", "shared"), "/shared");
  serveDir(app, resolve("public", "fonts"), "/fonts");

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
  const body = BINARY.test(type) ? readFileSync(path) : readFileSync(path, "utf-8");
  return async (
    _req: unknown,
    reply: { type(t: string): void; header(k: string, v: string): void },
  ) => {
    reply.type(type);
    // Fonts never change under a name; everything else is re-read on deploy, so keep it fresh.
    if (type.startsWith("font/"))
      reply.header("Cache-Control", "public, max-age=31536000, immutable");
    return body;
  };
}
