import api from "./api";
import { EthereumQuoter } from "./chains";
import { config } from "./config";
import { start } from "./endpoints";
import { logger } from "./logger";
import { HydrationPricer } from "./pricer";
import type { ChainQuoter } from "./types";

const BANNER = String.raw`
  ██████╗ ██╗   ██╗ ██████╗ ████████╗███████╗██████╗
 ██╔═══██╗██║   ██║██╔═══██╗╚══██╔══╝██╔════╝██╔══██╗
 ██║   ██║██║   ██║██║   ██║   ██║   █████╗  ██████╔╝
 ██║▄▄ ██║██║   ██║██║   ██║   ██║   ██╔══╝  ██╔══██╗
 ╚██████╔╝╚██████╔╝╚██████╔╝   ██║   ███████╗██║  ██║
  ╚══▀▀═╝  ╚═════╝  ╚═════╝    ╚═╝   ╚══════╝╚═╝  ╚═╝
            relay-fee quoter
`;

async function main(): Promise<void> {
  console.log(BANNER);
  logger.info("quoter starting...");

  const pricer = new HydrationPricer(config.hydrationRpc);
  const chains: Record<string, ChainQuoter> = {
    ethereum: new EthereumQuoter(config.ethereum),
  };

  api(pricer, chains);
  await start();
}

main().catch((err) => {
  logger.error(err);
  process.exit(1);
});
