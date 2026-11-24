import { getAddress, isAddress } from "viem";

import type { ifs } from "@whm/common/evm";

import type { MigrationStep } from "./types";

import intentDispatcherJson from "../../../contracts/out/IntentDispatcher.sol/IntentDispatcher.json";

const step: MigrationStep = {
  name: "012-set-btc-price-route@dispatcher",
  description: "Price BTC orders from the ETH/USD and BTC/USD feeds",
  action: async (ctx) => {
    const asset = ctx.env.BTC_ASSET_NEAR;
    const ethFeed = ctx.env.ETH_USD_FEED_HYDRATION;
    const destFeed = ctx.env.BTC_USD_FEED_HYDRATION;
    const destDecimals = Number(ctx.env.BTC_DECIMALS_NEAR);
    if (!asset) throw new Error("Missing BTC_ASSET_NEAR");
    if (!ethFeed || !isAddress(ethFeed)) throw new Error(`Missing or invalid ETH_USD_FEED_HYDRATION: ${ethFeed}`);
    if (!destFeed || !isAddress(destFeed)) throw new Error(`Missing or invalid BTC_USD_FEED_HYDRATION: ${destFeed}`);
    if (!Number.isInteger(destDecimals)) throw new Error(`Missing or invalid BTC_DECIMALS_NEAR: ${ctx.env.BTC_DECIMALS_NEAR}`);

    const contract = ctx.outputs["001-deploy-dispatcher"].proxyAddress as `0x${string}`;
    const { walletClient, publicClient } = ctx.wallet.hydration;
    const { abi } = intentDispatcherJson as ifs.ContractArtifact;

    const route = { ethFeed: getAddress(ethFeed), destFeed: getAddress(destFeed), destDecimals };
    const txHash = await walletClient.writeContract({
      address: contract,
      abi,
      functionName: "setPriceRoute",
      args: [asset, route],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error(`setPriceRoute reverted in ${txHash}`);

    // Price it once: a wrong feed, a dead feed or wrong decimals fail here, not on a user's order.
    const outPerIn = (await publicClient.readContract({
      address: contract,
      abi,
      functionName: "outPerIn",
      args: [asset],
    })) as bigint;

    return { txHash, contract, asset, outPerIn: outPerIn.toString() };
  },
};

export default step;
