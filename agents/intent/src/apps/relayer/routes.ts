import type { FastifyInstance } from "fastify";
import { isAddress } from "viem";

import { submitDeposit } from "./oneclick";

/**
 * The notifier's own endpoints.
 *
 * Manual trigger — public, no auth. Fires a 1Click submission by hand (e.g. if the socket was down
 * when the event fired). Bypasses the watcher's dedupe, so a retry always reaches 1Click.
 *
 * @param app Fastify instance.
 */
export function routes(app: FastifyInstance): void {
  app.post<{ Body: { depositAddress?: string; txHash?: string } }>(
    "/api/submit",
    async (req, reply) => {
      const { depositAddress, txHash } = req.body ?? {};
      if (!depositAddress || !isAddress(depositAddress) || typeof txHash !== "string") {
        return reply
          .code(400)
          .send({ error: "depositAddress (address) and txHash (string) required" });
      }
      try {
        const r = await submitDeposit(depositAddress, txHash);
        return { status: r.status, correlationId: r.correlationId };
      } catch (e) {
        return reply.code(502).send({ error: (e as Error).message });
      }
    },
  );
}
