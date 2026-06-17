import { isAddress } from "viem";

import type { ifs } from "@whm/common/evm";

import type { MigrationStep } from "./types";

import intentReceiverJson from "../../../contracts/out/IntentReceiver.sol/IntentReceiver.json";

/**
 * Authorize intent relayer #1 on IntentReceiver. Authorizing flips redemption from permissionless to
 * gated: only authorized relayers may redeem during the exclusive window after a VAA is issued.
 * Add more relayers as further steps (RELAYER_2 → 013-authorize-relayer-2, …).
 */
const step: MigrationStep = {
  name: "012-authorize-relayer-1@receiver",
  description: "Authorize intent relayer #1 on IntentReceiver (Ethereum)",
  action: async (ctx) => {
    const relayer = ctx.env.RELAYER_1;
    if (!relayer || !isAddress(relayer)) {
      throw new Error(`Missing or invalid RELAYER_1: ${relayer}`);
    }

    const receiver = ctx.outputs["005-deploy-receiver"].proxyAddress as `0x${string}`;
    const { abi } = intentReceiverJson as ifs.ContractArtifact;

    const txHash = await ctx.wallet.ethereum.walletClient.writeContract({
      address: receiver,
      abi,
      functionName: "setAuthorizedRelayer",
      args: [relayer as `0x${string}`, true],
    });
    await ctx.wallet.ethereum.publicClient.waitForTransactionReceipt({ hash: txHash });

    return { txHash, receiver, authorizedRelayer: relayer };
  },
};

export default step;
