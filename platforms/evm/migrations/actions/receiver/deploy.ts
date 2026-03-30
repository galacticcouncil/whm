import { encodeFunctionData } from "viem";

import type { ifs } from "../../../lib";
import type { WalletContext } from "../../types";

import messageReceiverJson from "../../../contracts/out/MessageReceiver.sol/MessageReceiver.json";
import erc1967ProxyJson from "../../../contracts/out/ERC1967Proxy.sol/ERC1967Proxy.json";

export type DeployReceiverParams = WalletContext & {
  wormholeCore: `0x${string}`;
  proxy?: `0x${string}`;
};

export type DeployReceiverResult = {
  implAddress: string;
  proxyAddress: string;
  ownerAddress: string;
};

export async function deployReceiver(params: DeployReceiverParams): Promise<DeployReceiverResult> {
  const { publicClient, walletClient, account, wormholeCore, proxy } = params;
  const { abi, bytecode } = messageReceiverJson as ifs.ContractArtifact;

  // Deploy implementation
  const implHash = await walletClient.deployContract({
    abi,
    bytecode: bytecode.object,
    args: [],
  });
  const implReceipt = await publicClient.waitForTransactionReceipt({ hash: implHash });
  if (!implReceipt.contractAddress) {
    throw new Error("Implementation deployment failed — no contract address.");
  }
  const implAddress = implReceipt.contractAddress;

  // Upgrade existing proxy
  if (proxy) {
    const upgradeHash = await walletClient.writeContract({
      address: proxy,
      abi,
      functionName: "upgradeToAndCall",
      args: [implAddress, "0x"],
    });
    await publicClient.waitForTransactionReceipt({ hash: upgradeHash });

    return { implAddress, proxyAddress: proxy, ownerAddress: account.address };
  }

  // Deploy new proxy
  const initializeData = encodeFunctionData({
    abi,
    functionName: "initialize",
    args: [wormholeCore],
  });
  const { abi: proxyAbi, bytecode: proxyBytecode } = erc1967ProxyJson as ifs.ContractArtifact;

  const proxyHash = await walletClient.deployContract({
    abi: proxyAbi,
    bytecode: proxyBytecode.object,
    args: [implAddress, initializeData],
  });
  const proxyReceipt = await publicClient.waitForTransactionReceipt({ hash: proxyHash });
  if (!proxyReceipt.contractAddress) {
    throw new Error("Proxy deployment failed — no contract address.");
  }

  return {
    implAddress,
    proxyAddress: proxyReceipt.contractAddress,
    ownerAddress: account.address,
  };
}
