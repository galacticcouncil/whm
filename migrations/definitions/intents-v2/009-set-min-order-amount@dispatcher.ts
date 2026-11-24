import type { ifs } from "@whm/common/evm";

import type { MigrationStep } from "./types";

import intentDispatcherJson from "../../../contracts/out/IntentDispatcher.sol/IntentDispatcher.json";

const step: MigrationStep = {
  name: "009-set-min-order-amount@dispatcher",
  description: "Set the dispatcher's minimum order — POA's ETH minimum deposit",
  action: async (ctx) => {
    const minOrderAmount = BigInt(ctx.env.MIN_ORDER_AMOUNT ?? "");
    if (minOrderAmount <= 0n) throw new Error(`Missing or invalid MIN_ORDER_AMOUNT: ${ctx.env.MIN_ORDER_AMOUNT}`);
    const args = [minOrderAmount] as const;
    const contract = ctx.outputs["001-deploy-dispatcher"].proxyAddress as `0x${string}`;
    const { walletClient, publicClient } = ctx.wallet.hydration;
    const { abi } = intentDispatcherJson as ifs.ContractArtifact;

    const txHash = await walletClient.writeContract({ address: contract, abi, functionName: "setMinOrderAmount", args });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error(`setMinOrderAmount reverted in ${txHash}`);

    return { txHash, contract, minOrderAmount: minOrderAmount.toString() };
  },
};

export default step;
