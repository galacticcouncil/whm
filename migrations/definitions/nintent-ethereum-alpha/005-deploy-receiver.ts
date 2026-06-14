import type { MigrationStep } from "./types";
import { deploy } from "../../actions/intent-receiver/deploy";

const step: MigrationStep = {
  name: "005-deploy-receiver",
  description: "Deploy IntentReceiver UUPS proxy on Ethereum (direct-TokenBridge WTT redeemer)",
  action: async (ctx) => {
    const tokenBridge = ctx.env.TOKEN_BRIDGE_ETHEREUM;
    const wrappedNative = ctx.env.WETH_DEST_ASSET;

    if (!tokenBridge || !wrappedNative) {
      throw new Error("Missing TOKEN_BRIDGE_ETHEREUM / WETH_DEST_ASSET for IntentReceiver deploy");
    }

    return await deploy({
      ...ctx.wallet.ethereum,
      tokenBridge: tokenBridge as `0x${string}`,
      wrappedNative: wrappedNative as `0x${string}`,
    });
  },
};

export default step;
