import type { FastifyInstance } from "fastify";
import type { JsonRpcProvider } from "near-api-js";

import { depositAddress } from "../../near/deposit";
import type { Deriver } from "../../near/derive";

/** A Hydration EVM address, or the same left-padded to 32 bytes — what `TransferMsg.recipient` takes. */
const RECIPIENT = /^0x([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;

/**
 * `GET /api/withdraw/:chain/:address` → the NEAR account `address` withdraws through, and `send` —
 * the two arguments the chain's emitter takes beside the amount. 400 for an address the emitter would
 * refuse.
 *
 * `GET /api/deposit/:chain/:recipient?refund=<address>` → the address to pay the coin to, on its own
 * chain, for it to arrive on Hydration at `recipient`, and the order behind it. `refund` is where a
 * refused deposit goes back to — part of the order, so it changes the address; the app should ask
 * for it.
 *
 * 404 for an unknown chain on both.
 *
 * @param provider A NEAR provider.
 * @param derivers One deriver per chain, by route key.
 * @returns Route registration.
 */
export function routes(provider: JsonRpcProvider, derivers: Record<string, Deriver>) {
  return (app: FastifyInstance): void => {
    app.get<{ Params: { chain: string; address: string } }>(
      "/api/withdraw/:chain/:address",
      async (req, reply) => {
        const { chain, address } = req.params;
        const deriver = derivers[chain];
        if (!deriver) return reply.code(404).send({ error: `unknown chain ${chain}` });

        const destination = deriver.chain.encode(address);
        if (!destination) return reply.code(400).send({ error: `not a valid ${chain} address` });

        try {
          const account = await deriver.account(address);
          return { chain, address, account, send: { destination, nearAccount: `0x${account}` } };
        } catch (e) {
          return reply.code(502).send({ error: (e as Error).message });
        }
      },
    );

    app.get<{ Params: { chain: string; recipient: string }; Querystring: { refund?: string } }>(
      "/api/deposit/:chain/:recipient",
      async (req, reply) => {
        const { chain, recipient } = req.params;
        const { refund } = req.query;
        const deriver = derivers[chain];
        if (!deriver) return reply.code(404).send({ error: `unknown chain ${chain}` });
        if (!RECIPIENT.test(recipient)) {
          return reply.code(400).send({ error: "recipient must be a 0x Hydration EVM address" });
        }
        if (refund && !deriver.chain.encode(refund)) {
          return reply.code(400).send({ error: `refund is not a valid ${chain} address` });
        }

        try {
          const { address, order } = await depositAddress(provider, deriver.chain, recipient, refund);
          return { chain, recipient, refund: refund ?? null, address, order };
        } catch (e) {
          return reply.code(502).send({ error: (e as Error).message });
        }
      },
    );
  };
}
