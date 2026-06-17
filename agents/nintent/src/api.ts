import { isAddress } from "viem";

import { source } from "./config";
import { app } from "./endpoints";
import { submitDeposit } from "./oneclick";
import { IntentWatcher } from "./watcher";

export default function apiHandler(watcher: IntentWatcher): void {
  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/status", async () => ({
    uptime: process.uptime(),
    chain: source.name,
    receiver: source.receiver,
    wss: source.wssUrl,
    processed: watcher.processed,
  }));

  // Manual trigger — public, no auth. Fire a 1Click submission by hand (e.g. if the socket was down
  // when the event fired). Bypasses the watcher's dedupe so a retry always reaches 1Click.
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
