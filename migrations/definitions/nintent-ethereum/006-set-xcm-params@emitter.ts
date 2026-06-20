import { parseEther } from "viem";

import type { ifs } from "@whm/common/evm";

import type { MigrationStep } from "./types";

import intentEmitterWttJson from "../../../contracts/out/IntentEmitterWtt.sol/IntentEmitterWtt.json";

const step: MigrationStep = {
  name: "006-set-xcm-params@emitter",
  description: "Bump xcmFee + xcmExecutionFee on the Hydration IntentEmitter (preserve gas/refTime/proofSize)",
  action: async (ctx) => {
    if (!ctx.env.XCM_FEE) throw new Error("Missing XCM_FEE (GLMR, decimal)");
    if (!ctx.env.XCM_EXECUTION_FEE) throw new Error("Missing XCM_EXECUTION_FEE (GLMR, decimal)");
    const xcmFee = parseEther(ctx.env.XCM_FEE); // GLMR has 18 decimals
    const xcmExecutionFee = parseEther(ctx.env.XCM_EXECUTION_FEE);

    const emitter = ctx.outputs["001-deploy-emitter"].proxyAddress as `0x${string}`;
    const { walletClient, publicClient } = ctx.wallet.hydration;
    const { abi } = intentEmitterWttJson as ifs.ContractArtifact;

    // setXcmParams writes all five fields at once — read the three we keep so they pass through unchanged.
    const read = (functionName: string) =>
      publicClient.readContract({ address: emitter, abi, functionName }) as Promise<bigint>;
    const [gasLimit, refTime, proofSize] = await Promise.all([
      read("xcmGasLimit"),
      read("xcmTransactRefTime"),
      read("xcmTransactProofSize"),
    ]);

    const txHash = await walletClient.writeContract({
      address: emitter,
      abi,
      functionName: "setXcmParams",
      args: [xcmFee, xcmExecutionFee, gasLimit, refTime, proofSize],
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    return {
      txHash,
      emitter,
      xcmFee: xcmFee.toString(),
      xcmExecutionFee: xcmExecutionFee.toString(),
      xcmGasLimit: gasLimit.toString(),
      xcmTransactRefTime: refTime.toString(),
      xcmTransactProofSize: proofSize.toString(),
    };
  },
};

export default step;
