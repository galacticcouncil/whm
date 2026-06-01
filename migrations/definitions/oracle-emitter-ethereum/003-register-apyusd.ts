import { encodeFunctionData, keccak256, toBytes } from "viem";

import type { MigrationStep } from "../../evm";
import { registerFeed } from "../../actions/oracle-emitter-ethereum/registerFeed";

const step: MigrationStep = {
  name: "register-apyusd",
  description: "Register APYUSD feed (convertToAssets(1e18))",
  action: async (ctx) => {
    const source = ctx.env.APYUSD_VAULT;
    if (!source) throw new Error("Missing APYUSD_VAULT");

    const call = encodeFunctionData({
      abi: [
        {
          name: "convertToAssets",
          type: "function",
          stateMutability: "view",
          inputs: [{ name: "shares", type: "uint256" }],
          outputs: [{ type: "uint256" }],
        },
      ],
      functionName: "convertToAssets",
      args: [10n ** 18n],
    });

    return await registerFeed({
      ...ctx.wallet,
      proxy: ctx.outputs["deploy"].proxyAddress as `0x${string}`,
      assetId: keccak256(toBytes("APYUSD")),
      source: source as `0x${string}`,
      call,
    });
  },
};

export default step;
