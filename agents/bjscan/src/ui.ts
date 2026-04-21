import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { app } from "./endpoints";

const TRANSFER_HTML_PATH = resolve("public/transfer.html");
const LOGO_PATH = resolve("public/logo.png");

export default function uiHandler(): void {
  app.get("/logo.png", async (_req, reply) => {
    reply.type("image/png");
    return readFileSync(LOGO_PATH);
  });

  app.get("/:id", async (_req, reply) => {
    reply.type("text/html; charset=utf-8");
    return readFileSync(TRANSFER_HTML_PATH, "utf-8");
  });
}
