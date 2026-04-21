import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { app } from "./endpoints";

const TRANSFER_HTML_PATH = resolve("public/transfer.html");
const FAVICON_PATH = resolve("public/favicon.svg");

export default function uiHandler(): void {
  app.get("/favicon.svg", async (_req, reply) => {
    reply.type("image/svg+xml");
    return readFileSync(FAVICON_PATH, "utf-8");
  });

  app.get("/:id", async (_req, reply) => {
    reply.type("text/html; charset=utf-8");
    return readFileSync(TRANSFER_HTML_PATH, "utf-8");
  });
}
