import type { FastifyInstance } from "fastify";

import type { Deriver } from "../../near/derive";

/**
 * `GET /api/:chain/:address` → the account `address` derives on that chain, and the two arguments
 * the chain's emitter takes beside the amount. 404 for an unknown chain, 400 for an address the
 * emitter would refuse.
 *
 * @param derivers One deriver per chain, by route key.
 * @returns Route registration.
 */
export function routes(derivers: Record<string, Deriver>) {
  return (app: FastifyInstance): void => {
    app.get<{ Params: { chain: string; address: string } }>("/api/:chain/:address", async (req, reply) => {
      const { chain, address } = req.params;
      const deriver = derivers[chain];
      if (!deriver) return reply.code(404).send({ error: `unknown chain ${chain}` });

      const destination = deriver.chain.encode(address);
      if (!destination) return reply.code(400).send({ error: `not a valid ${chain} address` });

      try {
        const account = await deriver.account(address);
        return { chain, address, account, nearAccount: `0x${account}`, destination };
      } catch (e) {
        return reply.code(502).send({ error: (e as Error).message });
      }
    });
  };
}
