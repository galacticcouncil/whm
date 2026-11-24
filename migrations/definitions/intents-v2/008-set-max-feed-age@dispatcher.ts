import type { ifs } from "@whm/common/evm";

import type { MigrationStep } from "./types";

import intentDispatcherJson from "../../../contracts/out/IntentDispatcher.sol/IntentDispatcher.json";

const step: MigrationStep = {
  name: "008-set-max-feed-age@dispatcher",
  description: "Set the oldest feed answer the dispatcher prices from",
  action: async (ctx) => {
    const maxFeedAge = BigInt(ctx.env.MAX_FEED_AGE ?? "");
    if (maxFeedAge <= 0n) throw new Error(`Missing or invalid MAX_FEED_AGE: ${ctx.env.MAX_FEED_AGE}`);
    const args = [maxFeedAge] as const;
    const contract = ctx.outputs["001-deploy-dispatcher"].proxyAddress as `0x${string}`;
    const { walletClient, publicClient } = ctx.wallet.hydration;
    const { abi } = intentDispatcherJson as ifs.ContractArtifact;
    // Before any price route: at 0 every feed is stale, so 010 could not check its route.
    const txHash = await walletClient.writeContract({ address: contract, abi, functionName: "setMaxFeedAge", args });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error(`setMaxFeedAge reverted in ${txHash}`);

    return { txHash, contract, maxFeedAge: maxFeedAge.toString() };
  },
};

export default step;
