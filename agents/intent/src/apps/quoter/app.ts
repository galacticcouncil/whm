import { banner } from "../../banner";
import log from "../../logger";
import { boot, serve } from "../../server";

import { EthereumQuoter } from "./chains";
import { APP_NAME, config } from "./config";
import { routes } from "./routes";
import type { ChainQuoter } from "./types";

/**
 * Prices the destination relay fee, so the SDK can size `maxRelayFee` before an order exists.
 *
 * It only prices — no keys, no VAAs, no submission. The relayer does not use this: by the time it
 * runs, the call is real and `estimateContractGas` beats any forecast.
 */
async function start(): Promise<void> {
  banner(APP_NAME);

  const chains: Record<string, ChainQuoter> = {
    ethereum: new EthereumQuoter(config.ethereum),
  };

  if (config.ethereum.gasLimitOverride) {
    log.warn(`ETH_GAS_LIMIT=${config.ethereum.gasLimitOverride} overrides the modelled envelope`);
  }

  await serve({
    name: APP_NAME,
    routes: routes(chains),
    status: async () => ({
      chains: Object.fromEntries(
        await Promise.all(
          Object.entries(chains).map(async ([name, c]) => {
            const gas = await c.estimateGas();
            return [
              name,
              {
                gasLimit: gas.total.toString(),
                intrinsic: gas.intrinsic.toString(),
                calldata: gas.calldata.toString(),
                execution: gas.execution.toString(),
                signatures: gas.signatures,
                calldataBytes: gas.calldataBytes,
              },
            ] as const;
          }),
        ),
      ),
    }),
  });
}

boot(APP_NAME, start);
