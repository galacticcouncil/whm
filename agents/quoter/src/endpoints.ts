import cors from "@fastify/cors";
import Fastify from "fastify";

import { config } from "./config";
import { logger } from "./logger";

export const app = Fastify({ logger: false });

export async function start(): Promise<void> {
  await app.register(cors, { origin: true });
  await app.listen({ port: config.port, host: "0.0.0.0" });
  logger.info(`quoter listening on :${config.port}`);
}
