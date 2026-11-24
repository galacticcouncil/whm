import { getAddress, isAddress } from "viem";

import type { ifs } from "@whm/common/evm";

import type { MigrationStep } from "./types";

import intentDispatcherJson from "../../../contracts/out/IntentDispatcher.sol/IntentDispatcher.json";

const step: MigrationStep = {
  name: "011-set-near-price-route@dispatcher",
  description: "Price NEAR orders from the ETH/USD and NEAR/USD feeds",
  action: async (ctx) => {
    const asset = ctx.env.NEAR_ASSET_NEAR;
    const ethFeed = ctx.env.ETH_USD_FEED_HYDRATION;
    const destFeed = ctx.env.NEAR_USD_FEED_HYDRATION;
    const destDecimals = Number(ctx.env.NEAR_DECIMALS_NEAR);
    if (!asset) throw new Error("Missing NEAR_ASSET_NEAR");
    if (!ethFeed || !isAddress(ethFeed)) throw new Error(`Missing or invalid ETH_USD_FEED_HYDRATION: ${ethFeed}`);
    if (!destFeed || !isAddress(destFeed)) throw new Error(`Missing or invalid NEAR_USD_FEED_HYDRATION: ${destFeed}`);
    if (!Number.isInteger(destDecimals)) throw new Error(`Missing or invalid NEAR_DECIMALS_NEAR: ${ctx.env.NEAR_DECIMALS_NEAR}`);

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
