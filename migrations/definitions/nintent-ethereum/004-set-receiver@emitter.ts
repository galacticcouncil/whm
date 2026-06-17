import { isAddress, pad } from "viem";

import type { ifs } from "@whm/common/evm";

import type { MigrationStep } from "./types";

import intentEmitterWttJson from "../../../contracts/out/IntentEmitterWtt.sol/IntentEmitterWtt.json";

const step: MigrationStep = {
  name: "004-set-receiver@emitter",
  description: "Set the Ethereum IntentReceiver (Wormhole bytes32 address) on the Hydration IntentEmitter",
  action: async (ctx) => {
    const receiver = ctx.env.INTENT_RECEIVER;
    if (!receiver || !isAddress(receiver)) {
      throw new Error(`Missing or invalid INTENT_RECEIVER: ${receiver}`);
    }
    // Wormhole addresses are 32 bytes — left-pad the 20-byte EVM address.
    const intentReceiver = pad(receiver as `0x${string}`, { size: 32 });

    const emitter = ctx.outputs["001-deploy-emitter"].proxyAddress as `0x${string}`;
    const { walletClient, publicClient } = ctx.wallet.hydration;
    const { abi } = intentEmitterWttJson as ifs.ContractArtifact;

    const txHash = await walletClient.writeContract({
      address: emitter,
      abi,
      functionName: "setIntentReceiver",
      args: [intentReceiver],
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    return { txHash, emitter, receiver, intentReceiver };
  },
};

export default step;
