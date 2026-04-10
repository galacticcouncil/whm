import type { ifs } from "../../../lib";
import type { MigrationStep } from "../../types";
import { setOwner } from "../../actions/setOwner";

import xcmTransactorJson from "../../../contracts/out/XcmTransactor.sol/XcmTransactor.json";

const step: MigrationStep = {
  name: "transfer-ownership",
  description: "Grant XCM operator to current owner, then transfer ownership to Hydration TC MDA",
  action: async (ctx) => {
    const newOwner = ctx.env.NEW_OWNER;
    if (!newOwner) throw new Error("Missing NEW_OWNER");

    const proxyAddress = ctx.outputs["deploy-proxy"].proxyAddress as `0x${string}`;
    const transactorAddress = ctx.outputs["deploy-transactor"].proxyAddress as `0x${string}`;
    const { abi } = xcmTransactorJson as ifs.ContractArtifact;

    // Grant xcmOperator to current owner before transferring ownership
    const operatorTxHash = await ctx.wallet.walletClient.writeContract({
      address: transactorAddress,
      abi,
      functionName: "setXcmOperator",
      args: [ctx.wallet.account.address, true],
    });
    await ctx.wallet.publicClient.waitForTransactionReceipt({ hash: operatorTxHash });

    const proxyResult = await setOwner({
      ...ctx.wallet,
      contract: proxyAddress,
      newOwner: newOwner as `0x${string}`,
    });

    const transactorResult = await setOwner({
      ...ctx.wallet,
      contract: transactorAddress,
      newOwner: newOwner as `0x${string}`,
    });

    return {
      operatorTxHash,
      xcmOperator: ctx.wallet.account.address,
      proxyTxHash: proxyResult.txHash,
      transactorTxHash: transactorResult.txHash,
      proxyAddress: proxyResult.contract,
      transactorAddress: transactorResult.contract,
      newOwner,
    };
  },
};

export default step;
