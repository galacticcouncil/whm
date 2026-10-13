import type { FastifyInstance } from "fastify";

import log from "../../logger";
import { config } from "./config";
import type { ChainQuoter, RelayFeeQuery, RelayFeeQuote } from "./types";

const BPS = 10_000n;

/**
 * The quoter's own endpoints.
 *
 * @param chains Destination chains this service can quote.
 * @returns A route registrar for `serve`.
 */
export function routes(chains: Record<string, ChainQuoter>) {
  return (app: FastifyInstance): void => {
    app.get("/relay-fee", async (req, reply) => {
      const { chain, feeAsset = "native", gasLimit, marginBps } = req.query as RelayFeeQuery;
      if (!chain) {
        return reply.code(400).send({ error: "query param `chain` is required" });
      }

      const quoter = chains[chain];
      if (!quoter) {
        return reply.code(400).send({ error: `unknown chain '${chain}'` });
      }

      // The relay fee is paid out of what IntentReceiver delivers, and that is always native — so
      // refuse rather than answer in wei and let the caller believe it got its own asset.
      if (!quoter.isNative(feeAsset)) {
        return reply
          .code(400)
          .send({ error: `only the native fee asset is quotable on ${chain}, got '${feeAsset}'` });
      }

      // Margin is per-caller: the relayer wants its real cost (marginBps=0), the SDK sizes
      // maxRelayFee with headroom (marginBps=2000). Defaults to FEE_MARGIN_BPS when omitted.
      const margin = marginBps !== undefined ? BigInt(marginBps) : config.feeMarginBps;

      try {
        const [gasPriceWei, gas] = await Promise.all([quoter.gasPrice(), quoter.estimateGas()]);
        // An explicit gasLimit replaces the model outright, so the breakdown would not describe
        // what was priced — it is left off rather than reported misleadingly.
        const limit = gasLimit ? BigInt(gasLimit) : gas.total;
        const costNativeWei = limit * gasPriceWei;

        const quote: RelayFeeQuote = {
          chain,
          feeAsset,
          feeRequested: ((costNativeWei * (BPS + margin)) / BPS).toString(),
          gasLimit: limit.toString(),
          gasPriceWei: gasPriceWei.toString(),
          costNativeWei: costNativeWei.toString(),
          marginBps: margin.toString(),
          ...(gasLimit
            ? {}
            : {
                gas: {
                  intrinsic: gas.intrinsic.toString(),
                  calldata: gas.calldata.toString(),
                  execution: gas.execution.toString(),
                  signatures: gas.signatures,
                  calldataBytes: gas.calldataBytes,
                },
              }),
        };
        return quote;
      } catch (err) {
        log.error(`quote failed (${chain}): ${(err as Error).message}`);
        return reply.code(502).send({ error: (err as Error).message });
      }
    });

    // The service predates `/api/`-prefixed routes and the SDK calls it here.
    app.get("/health", async () => ({ ok: true }));
  };
}
