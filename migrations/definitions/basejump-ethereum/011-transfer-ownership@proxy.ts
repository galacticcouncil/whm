import type { ifs } from "@whm/common/evm";
import xcmTransactorJson from "../../../contracts/out/XcmTransactor.sol/XcmTransactor.json";

import type { MigrationStep } from "./types";
import { setOwner } from "../../actions/setOwner";

const step: MigrationStep = {
  name: "011-transfer-ownership@proxy",
  description:
    "Grant XCM operator to current owner, then transfer BasejumpProxy + XcmTransactor ownership (Moonbeam)",
  action: async (ctx) => {
    const newOwner = ctx.env.PROXY_NEW_OWNER;
    if (!newOwner) throw new Error("Missing PROXY_NEW_OWNER");

    const proxyAddress = ctx.outputs["002-deploy-proxy"].proxyAddress as `0x${string}`;
    const transactorAddress = ctx.outputs["003-deploy-transactor"].proxyAddress as `0x${string}`;
    const { abi } = xcmTransactorJson as ifs.ContractArtifact;

    // Grant xcmOperator to current owner before transferring ownership
    const operatorTxHash = await ctx.wallet.moonbeam.walletClient.writeContract({
      address: transactorAddress,
      abi,
      functionName: "setXcmOperator",
      args: [ctx.wallet.moonbeam.account.address, true],
    });
    await ctx.wallet.moonbeam.publicClient.waitForTransactionReceipt({ hash: operatorTxHash });

    const proxyResult = await setOwner({
      ...ctx.wallet.moonbeam,
      contract: proxyAddress,
      newOwner: newOwner as `0x${string}`,
    });

    const transactorResult = await setOwner({
      ...ctx.wallet.moonbeam,
      contract: transactorAddress,
      newOwner: newOwner as `0x${string}`,
    });

    return {
      operatorTxHash,
      xcmOperator: ctx.wallet.moonbeam.account.address,
      proxyTxHash: proxyResult.txHash,
      transactorTxHash: transactorResult.txHash,
      proxyAddress: proxyResult.contract,
      transactorAddress: transactorResult.contract,
      newOwner,
    };
  },
};

export default step;
