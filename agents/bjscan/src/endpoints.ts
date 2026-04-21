import Fastify from "fastify";

import log from "./logger";
import { port } from "./config";

export const app = Fastify({ logger: false });

export async function start(): Promise<void> {
  await app.listen({ port, host: "0.0.0.0" });
  log.info(`listening on :${port}`);
}
