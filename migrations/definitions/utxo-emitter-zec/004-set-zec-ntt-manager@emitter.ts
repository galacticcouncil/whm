import { isAddress } from "viem";

import type { ifs } from "@whm/common/evm";

import type { MigrationStep } from "./types";

import zecUtxoEmitterJson from "../../../contracts/out/ZecUtxoEmitter.sol/ZecUtxoEmitter.json";

const step: MigrationStep = {
  name: "004-set-zec-ntt-manager@emitter",
  description: "Point the emitter's send at the ZEC NttManager",
  action: async (ctx) => {
    const manager = ctx.env.ZEC_NTT_MANAGER_HYDRATION;
    if (!manager || !isAddress(manager)) {
      throw new Error(`Missing or invalid ZEC_NTT_MANAGER_HYDRATION: ${manager}`);
    }

    const emitter = ctx.outputs["001-deploy-emitter"].proxyAddress as `0x${string}`;
    const { walletClient, publicClient } = ctx.wallet.hydration;
    const { abi } = zecUtxoEmitterJson as ifs.ContractArtifact;

    // send is live from here on — it reverts NotConfigured until this is set, which is why the fee comes first.
    const txHash = await walletClient.writeContract({
      address: emitter,
      abi,
      functionName: "setZecNttManager",
      args: [manager as `0x${string}`],
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    return { txHash, emitter, manager };
  },
};

export default step;
