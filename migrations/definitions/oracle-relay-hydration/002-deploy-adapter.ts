import type { MigrationStep } from "./types";
import { deploy } from "../../actions/aggregator-adapter/deploy";

const step: MigrationStep = {
  name: "002-deploy-adapter",
  description: "Deploy AggregatorAdapter for HDX (EMA oracle precompile) on Hydration",
  action: async (ctx) => {
    const feed = ctx.env.HDX_FEED;
    if (!feed) throw new Error("Missing HDX_FEED");

    return await deploy({
      ...ctx.wallet.hydration,
      feed: feed as `0x${string}`,
    });
  },
};

export default step;
