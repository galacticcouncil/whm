import { isAddress } from "viem";

import type { ifs } from "@whm/common/evm";

import type { MigrationStep } from "./types";

import intentForwarderJson from "../../../contracts/out/IntentForwarder.sol/IntentForwarder.json";

const step: MigrationStep = {
  name: "004-authorize-relayer-1@forwarder",
  description: "Grant relayer 1 the exclusive window on processOrder",
  action: async (ctx) => {
    const relayer = ctx.env.RELAYER_1;
    if (!relayer || !isAddress(relayer)) throw new Error(`Missing or invalid RELAYER_1: ${relayer}`);
    const args = [relayer as `0x${string}`, true] as const;
    const contract = ctx.outputs["002-deploy-forwarder"].proxyAddress as `0x${string}`;
    const { walletClient, publicClient } = ctx.wallet.ethereum;
    const { abi } = intentForwarderJson as ifs.ContractArtifact;
    // The first grant switches the window on for everyone else; revoking the last reopens it.
    const txHash = await walletClient.writeContract({ address: contract, abi, functionName: "setAuthorizedRelayer", args });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error(`setAuthorizedRelayer reverted in ${txHash}`);

    return { txHash, contract, relayer };
  },
};

export default step;
