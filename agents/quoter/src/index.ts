import Fastify from "fastify";

import { EthereumQuoter } from "./chains";
import { config } from "./config";
import { logger } from "./logger";
import { HydrationPricer } from "./pricer";
import type { ChainQuoter, RelayFeeQuery, RelayFeeQuote } from "./types";

const pricer = new HydrationPricer(config.hydrationRpc, config.feeMarginBps);

const chains: Record<string, ChainQuoter> = {
  ethereum: new EthereumQuoter(config.ethereum),
};

const app = Fastify({ logger: false });

app.get("/relay-fee", async (req, reply) => {
  const { chain, feeAsset, gasLimit } = req.query as RelayFeeQuery;
  if (!chain || !feeAsset) {
    return reply.code(400).send({ error: "query params `chain` and `feeAsset` are required" });
  }

  const quoter = chains[chain];
  if (!quoter) {
    return reply.code(400).send({ error: `unknown chain '${chain}'` });
  }

  try {
    const gasPriceWei = await quoter.gasPrice();
    const limit = gasLimit ? BigInt(gasLimit) : quoter.redeemGasLimit;
    const costNativeWei = limit * gasPriceWei;
    const feeRequested = await pricer.toFee(quoter, feeAsset, costNativeWei);

    const quote: RelayFeeQuote = {
      chain,
      feeAsset,
      feeRequested: feeRequested.toString(),
      gasLimit: limit.toString(),
      gasPriceWei: gasPriceWei.toString(),
      costNativeWei: costNativeWei.toString(),
    };
    return quote;
  } catch (err) {
    logger.error(`quote failed (${chain}/${feeAsset}): ${(err as Error).message}`);
    return reply.code(502).send({ error: (err as Error).message });
  }
});

app.get("/health", async () => ({ ok: true }));

app
  .listen({ port: config.port, host: "0.0.0.0" })
  .then(() => logger.info(`quoter listening on :${config.port}`))
  .catch((err) => {
    logger.error(err);
    process.exit(1);
  });
