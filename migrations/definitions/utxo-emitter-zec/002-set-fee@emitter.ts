import type { ifs } from "@whm/common/evm";

import type { MigrationStep } from "./types";

import zecUtxoEmitterJson from "../../../contracts/out/ZecUtxoEmitter.sol/ZecUtxoEmitter.json";

const step: MigrationStep = {
  name: "002-set-fee@emitter",
  description: "Set the ZEC each send keeps for the relayer's NEAR gas",
  action: async (ctx) => {
    const raw = ctx.env.ZEC_FEE;
    if (!raw || !/^\d+$/.test(raw)) {
      throw new Error(`Missing or invalid ZEC_FEE (zatoshi): ${raw}`);
    }
    const fee = BigInt(raw);

    const emitter = ctx.outputs["001-deploy-emitter"].proxyAddress as `0x${string}`;
    const { walletClient, publicClient } = ctx.wallet.hydration;
    const { abi } = zecUtxoEmitterJson as ifs.ContractArtifact;

    const txHash = await walletClient.writeContract({
      address: emitter,
      abi,
      functionName: "setFee",
      args: [fee],
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    return { txHash, emitter, fee: fee.toString() };
  },
};

export default step;
