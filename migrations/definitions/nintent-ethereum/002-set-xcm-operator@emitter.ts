import { isAddress } from "viem";

import type { ifs } from "@whm/common/evm";

import type { MigrationStep } from "./types";

import intentEmitterWttJson from "../../../contracts/out/IntentEmitterWtt.sol/IntentEmitterWtt.json";

const step: MigrationStep = {
  name: "002-set-xcm-operator@emitter",
  description: "Authorize the XCM operator on the Hydration IntentEmitter",
  action: async (ctx) => {
    const operator = ctx.env.XCM_OPERATOR;
    if (!operator || !isAddress(operator)) {
      throw new Error(`Missing or invalid XCM_OPERATOR: ${operator}`);
    }

    const emitter = ctx.outputs["001-deploy-emitter"].proxyAddress as `0x${string}`;
    const { walletClient, publicClient } = ctx.wallet.hydration;
    const { abi } = intentEmitterWttJson as ifs.ContractArtifact;

    const txHash = await walletClient.writeContract({
      address: emitter,
      abi,
      functionName: "setXcmOperator",
      args: [operator as `0x${string}`, true],
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    return { txHash, emitter, operator, enabled: "true" };
  },
};

export default step;
