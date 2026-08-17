import { encodeFunctionData, keccak256, toBytes } from "viem";

import type { MigrationStep } from "./types";
import { registerFeed } from "../../actions/oracle-emitter-ethereum/registerFeed";

const step: MigrationStep = {
  name: "004-register-wsteth@emitter",
  description: "Register WSTETH feed (stEthPerToken) on Ethereum OracleEmitter",
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
      ...ctx.wallet.ethereum,
      proxy: ctx.outputs["001-deploy-emitter"].proxyAddress as `0x${string}`,
      assetId: keccak256(toBytes("WSTETH")),
      source: source as `0x${string}`,
      call,
    });
  },
};

export default step;
