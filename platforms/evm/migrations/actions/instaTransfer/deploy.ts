import { encodeFunctionData } from "viem";

import type { ifs } from "../../../lib";
import type { WalletContext } from "../../types";

import instaTransferJson from "../../../contracts/out/InstaTransfer.sol/InstaTransfer.json";
import erc1967ProxyJson from "../../../contracts/out/ERC1967Proxy.sol/ERC1967Proxy.json";

export type DeployInstaTransferParams = WalletContext & {
  proxy?: `0x${string}`;
};

export type DeployInstaTransferResult = {
  implementationAddress: string;
  proxyAddress: string;
  ownerAddress: string;
};

export async function deployInstaTransfer(
  params: DeployInstaTransferParams,
): Promise<DeployInstaTransferResult> {
  const { publicClient, walletClient, account, proxy } = params;
  const { abi, bytecode } = instaTransferJson as ifs.ContractArtifact;

  const implHash = await walletClient.deployContract({
    abi,
    bytecode: bytecode.object,
    args: [],
  });

  const implReceipt = await publicClient.waitForTransactionReceipt({ hash: implHash });
  if (!implReceipt.contractAddress) {
    throw new Error("Implementation deployment failed — no contract address.");
  }

  const implementationAddress = implReceipt.contractAddress;

  if (proxy) {
    const upgradeHash = await walletClient.writeContract({
      address: proxy,
      abi,
      functionName: "upgradeToAndCall",
      args: [implementationAddress, "0x"],
    });
    await publicClient.waitForTransactionReceipt({ hash: upgradeHash });

    return {
      implementationAddress,
      proxyAddress: proxy,
      ownerAddress: account.address,
    };
  }

  const initializeData = encodeFunctionData({
    abi,
    functionName: "initialize",
    args: [],
  });

  const { abi: proxyAbi, bytecode: proxyBytecode } = erc1967ProxyJson as ifs.ContractArtifact;

  const proxyHash = await walletClient.deployContract({
    abi: proxyAbi,
    bytecode: proxyBytecode.object,
    args: [implementationAddress, initializeData],
  });

  const proxyReceipt = await publicClient.waitForTransactionReceipt({ hash: proxyHash });
  if (!proxyReceipt.contractAddress) {
    throw new Error("Proxy deployment failed — no contract address.");
  }

  return {
    implementationAddress,
    proxyAddress: proxyReceipt.contractAddress,
    ownerAddress: account.address,
  };
}
