import { pad } from "viem";

import type { ifs } from "@whm/common/evm";

import type { MigrationStep } from "./types";

import intentDispatcherJson from "../../../contracts/out/IntentDispatcher.sol/IntentDispatcher.json";

const step: MigrationStep = {
  name: "006-set-forwarder@dispatcher",
  description: "Address the dispatcher's transfers to the Ethereum forwarder",
  action: async (ctx) => {
    // Read from the deploy step, not env — the two ends cannot diverge that way.
    const forwarder = pad(ctx.outputs["002-deploy-forwarder"].proxyAddress as `0x${string}`, { size: 32 });
    const args = [forwarder] as const;
    const contract = ctx.outputs["001-deploy-dispatcher"].proxyAddress as `0x${string}`;
    const { walletClient, publicClient } = ctx.wallet.hydration;
    const { abi } = intentDispatcherJson as ifs.ContractArtifact;

    const txHash = await walletClient.writeContract({ address: contract, abi, functionName: "setForwarder", args });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error(`setForwarder reverted in ${txHash}`);

    return { txHash, contract, forwarder };
  },
};

export default step;
