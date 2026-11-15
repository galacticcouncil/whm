import { isAddress } from "viem";

import type { ifs } from "@whm/common/evm";

import type { MigrationStep } from "./types";

import intentDispatcherJson from "../../../contracts/out/IntentDispatcher.sol/IntentDispatcher.json";

const step: MigrationStep = {
  name: "005-set-ntt-manager@dispatcher",
  description: "Point the dispatcher at the WETH NttManagerWithPayload",
  action: async (ctx) => {
    const manager = ctx.env.NTT_MANAGER_HYDRATION;
    if (!manager || !isAddress(manager)) throw new Error(`Missing or invalid NTT_MANAGER_HYDRATION: ${manager}`);
    const args = [manager as `0x${string}`] as const;
    const contract = ctx.outputs["001-deploy-dispatcher"].proxyAddress as `0x${string}`;
    const { walletClient, publicClient } = ctx.wallet.hydration;
    const { abi } = intentDispatcherJson as ifs.ContractArtifact;
    // Reverts SettlementRouteMismatch unless the manager's token is Hydration WETH, so this also
    // proves the address.
    const txHash = await walletClient.writeContract({ address: contract, abi, functionName: "setNttManager", args });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error(`setNttManager reverted in ${txHash}`);

    return { txHash, contract, manager };
  },
};

export default step;
