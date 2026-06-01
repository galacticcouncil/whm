import { encodeFunctionData, keccak256, toBytes } from "viem";

import type { MigrationStep } from "../../evm";
import { registerFeed } from "../../actions/oracle-emitter-ethereum/registerFeed";

const step: MigrationStep = {
  name: "register-wsteth",
  description: "Register WSTETH feed (stEthPerToken)",
  action: async (ctx) => {
    const source = ctx.env.WSTETH_TOKEN;
    if (!source) throw new Error("Missing WSTETH_TOKEN");

    const call = encodeFunctionData({
      abi: [
        {
          name: "stEthPerToken",
          type: "function",
          stateMutability: "view",
          inputs: [],
          outputs: [{ type: "uint256" }],
        },
      ],
      functionName: "stEthPerToken",
    });

    return await registerFeed({
      ...ctx.wallet,
      proxy: ctx.outputs["deploy"].proxyAddress as `0x${string}`,
      assetId: keccak256(toBytes("WSTETH")),
      source: source as `0x${string}`,
      call,
    });
  },
};

export default step;
