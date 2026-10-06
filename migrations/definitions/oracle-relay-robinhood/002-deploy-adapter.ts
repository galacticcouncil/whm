import type { MigrationStep } from "./types";
import { deploy } from "../../actions/chainlink-adapter/deploy";

const step: MigrationStep = {
  name: "002-deploy-adapter",
  description: "Deploy ChainlinkAdapter for SPY/USD on Robinhood",
  action: async (ctx) => {
    const feed = ctx.env.SPY_USD_FEED;
    const maxAge = ctx.env.SPY_MAX_AGE;
    if (!feed) throw new Error("Missing SPY_USD_FEED");
    if (maxAge === undefined || maxAge === "") throw new Error("Missing SPY_MAX_AGE (0 disables the check)");

    return await deploy({
      ...ctx.wallet.robinhood,
      feed: feed as `0x${string}`,
      maxAge: BigInt(maxAge),
    });
  },
};

export default step;
