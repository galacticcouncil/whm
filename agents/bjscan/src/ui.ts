import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { app } from "./endpoints";

const TRANSFER_HTML_PATH = resolve("public/transfer.html");

export default function uiHandler(): void {
  app.get("/:id", async (_req, reply) => {
    reply.type("text/html; charset=utf-8");
    return readFileSync(TRANSFER_HTML_PATH, "utf-8");
  });
}
