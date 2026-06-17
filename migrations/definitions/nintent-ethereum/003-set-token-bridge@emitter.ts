import { isAddress } from "viem";

import type { ifs } from "@whm/common/evm";

import type { MigrationStep } from "./types";

import intentEmitterWttJson from "../../../contracts/out/IntentEmitterWtt.sol/IntentEmitterWtt.json";

const step: MigrationStep = {
  name: "003-set-token-bridge@emitter",
  description: "Set the Moonbeam Wormhole TokenBridge on the Hydration IntentEmitter",
  action: async (ctx) => {
    const tokenBridge = ctx.env.TOKEN_BRIDGE_MOONBEAM;
    if (!tokenBridge || !isAddress(tokenBridge)) {
      throw new Error(`Missing or invalid TOKEN_BRIDGE_MOONBEAM: ${tokenBridge}`);
    }

    const emitter = ctx.outputs["001-deploy-emitter"].proxyAddress as `0x${string}`;
    const { walletClient, publicClient } = ctx.wallet.hydration;
    const { abi } = intentEmitterWttJson as ifs.ContractArtifact;

    const txHash = await walletClient.writeContract({
      address: emitter,
      abi,
      functionName: "setTokenBridge",
      args: [tokenBridge as `0x${string}`],
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    return { txHash, emitter, tokenBridge };
  },
};

export default step;
