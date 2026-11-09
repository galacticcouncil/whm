import { isAddress } from "viem";

import type { ifs } from "@whm/common/evm";

import type { MigrationStep } from "./types";

import zecUtxoEmitterJson from "../../../contracts/out/ZecUtxoEmitter.sol/ZecUtxoEmitter.json";

const step: MigrationStep = {
  name: "003-set-near-ntt-manager@emitter",
  description: "Point the emitter's refuel at the NEAR NttManager",
  action: async (ctx) => {
    const manager = ctx.env.NEAR_NTT_MANAGER_HYDRATION;
    if (!manager || !isAddress(manager)) {
      throw new Error(`Missing or invalid NEAR_NTT_MANAGER_HYDRATION: ${manager}`);
    }

    const emitter = ctx.outputs["001-deploy-emitter"].proxyAddress as `0x${string}`;
    const { walletClient, publicClient } = ctx.wallet.hydration;
    const { abi } = zecUtxoEmitterJson as ifs.ContractArtifact;

    // refuel's rail. Its token() is what refuel buys, so a wrong manager fails the first refuel, not a user.
    const txHash = await walletClient.writeContract({
      address: emitter,
      abi,
      functionName: "setNearNttManager",
      args: [manager as `0x${string}`],
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    return { txHash, emitter, manager };
  },
};

export default step;
