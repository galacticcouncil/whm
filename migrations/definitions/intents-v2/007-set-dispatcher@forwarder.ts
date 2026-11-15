import { pad } from "viem";

import type { ifs } from "@whm/common/evm";

import type { MigrationStep } from "./types";

import intentForwarderJson from "../../../contracts/out/IntentForwarder.sol/IntentForwarder.json";

const step: MigrationStep = {
  name: "007-set-dispatcher@forwarder",
  description: "Pin the Hydration dispatcher whose transfers the forwarder takes as orders",
  action: async (ctx) => {
    const dispatcher = pad(ctx.outputs["001-deploy-dispatcher"].proxyAddress as `0x${string}`, { size: 32 });
    const args = [dispatcher] as const;
    const contract = ctx.outputs["002-deploy-forwarder"].proxyAddress as `0x${string}`;
    const { walletClient, publicClient } = ctx.wallet.ethereum;
    const { abi } = intentForwarderJson as ifs.ContractArtifact;
    // Until this lands processOrder reverts NotConfigured, so the corridor stays dark.
    const txHash = await walletClient.writeContract({ address: contract, abi, functionName: "setDispatcher", args });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error(`setDispatcher reverted in ${txHash}`);

    return { txHash, contract, dispatcher };
  },
};

export default step;
