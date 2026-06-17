import { config } from "./config";
import { app } from "./endpoints";
import { logger } from "./logger";
import type { ChainQuoter, Pricer, RelayFeeQuery, RelayFeeQuote } from "./types";

export default function apiHandler(pricer: Pricer, chains: Record<string, ChainQuoter>): void {
  app.get("/relay-fee", async (req, reply) => {
    // feeAsset omitted ⇒ native: price the relayer's gas cost in the chain's own token (no FX).
    const { chain, feeAsset = "native", gasLimit, marginBps } = req.query as RelayFeeQuery;
    if (!chain) {
      return reply.code(400).send({ error: "query param `chain` is required" });
    }

    const quoter = chains[chain];
    if (!quoter) {
      return reply.code(400).send({ error: `unknown chain '${chain}'` });
    }

    // Margin is per-caller: the relayer asks its real cost (marginBps=0), the UI sizes maxRelayFee
    // with headroom (a larger marginBps). Defaults to FEE_MARGIN_BPS when omitted.
    const margin = marginBps !== undefined ? BigInt(marginBps) : config.feeMarginBps;

    try {
      const gasPriceWei = await quoter.gasPrice();
      const limit = gasLimit ? BigInt(gasLimit) : quoter.gasLimit;
      const costNativeWei = limit * gasPriceWei;
      const feeRequested = await pricer.toFee(quoter, feeAsset, costNativeWei, margin);

      const quote: RelayFeeQuote = {
        chain,
        feeAsset,
        feeRequested: feeRequested.toString(),
        gasLimit: limit.toString(),
        gasPriceWei: gasPriceWei.toString(),
        costNativeWei: costNativeWei.toString(),
        marginBps: margin.toString(),
      };
      return quote;
    } catch (err) {
      logger.error(`quote failed (${chain}/${feeAsset}): ${(err as Error).message}`);
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.get("/health", async () => ({ ok: true }));
}
