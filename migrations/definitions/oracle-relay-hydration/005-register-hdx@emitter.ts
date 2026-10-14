import { encodeFunctionData, keccak256, toBytes } from "viem";

import type { MigrationStep } from "./types";
import { registerFeed } from "../../actions/oracle-emitter-ethereum/registerFeed";

const step: MigrationStep = {
  name: "005-register-hdx@emitter",
  description: "Register HDX feed (AggregatorAdapter.latestRate) on Hydration OracleEmitter",
  action: async (ctx) => {
    const source = ctx.outputs["002-deploy-adapter"].address;

    const call = encodeFunctionData({
      abi: [
        {
          name: "latestRate",
          type: "function",
          stateMutability: "view",
          inputs: [],
          outputs: [{ type: "uint256" }],
        },
      ],
      functionName: "latestRate",
    });

    return await registerFeed({
      ...ctx.wallet.hydration,
      proxy: ctx.outputs["001-deploy-emitter"].proxyAddress as `0x${string}`,
      assetId: keccak256(toBytes("HDX")),
      source: source as `0x${string}`,
      call,
    });
  },
};

export default step;
