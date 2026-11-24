import { encodeFunctionData } from "viem";

import type { ifs } from "@whm/common/evm";
import { forgeArtifact } from "@whm/common/evm/artifacts";
import type { WalletContext } from "../types";

import emitterJson from "../../../contracts/out/BasejumpEmitter.sol/BasejumpEmitter.json";

const erc1967ProxyJson = forgeArtifact("ERC1967Proxy");

export type DeployParams = WalletContext & {
  wormholeId: number;
  wormholeCore: `0x${string}`;
  proxy?: `0x${string}`;
};

export type DeployResult = {
  implAddress: string;
  proxyAddress: string;
  ownerAddress: string;
  wormholeId: string;
};

export async function deploy(params: DeployParams): Promise<DeployResult> {
  const { publicClient, walletClient, account, wormholeCore, wormholeId, proxy } = params;
  const { abi, bytecode } = emitterJson as ifs.ContractArtifact;

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

  if (proxy) {
    const upgradeHash = await walletClient.writeContract({
      address: proxy,
      abi,
      functionName: "upgradeToAndCall",
      args: [implAddress, "0x"],
    });
    await publicClient.waitForTransactionReceipt({ hash: upgradeHash });

    return {
      implAddress,
      proxyAddress: proxy,
      ownerAddress: account.address,
      wormholeId: String(wormholeId),
    };
  }

  const initializeData = encodeFunctionData({
    abi,
    functionName: "initialize",
    args: [wormholeCore],
  });

  const { abi: proxyAbi, bytecode: proxyBytecode } = erc1967ProxyJson;

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
    wormholeId: String(wormholeId),
  };
}
