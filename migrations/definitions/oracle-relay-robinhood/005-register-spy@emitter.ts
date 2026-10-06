import { encodeFunctionData, keccak256, toBytes } from "viem";

import type { MigrationStep } from "./types";
import { registerFeed } from "../../actions/oracle-emitter-ethereum/registerFeed";

const step: MigrationStep = {
  name: "005-register-spy@emitter",
  description: "Register SPY feed (ChainlinkAdapter.latestRate) on Robinhood OracleEmitter",
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
      ...ctx.wallet.robinhood,
      proxy: ctx.outputs["001-deploy-emitter"].proxyAddress as `0x${string}`,
      assetId: keccak256(toBytes("SPY")),
      source: source as `0x${string}`,
      call,
    });
  },
};

export default step;
