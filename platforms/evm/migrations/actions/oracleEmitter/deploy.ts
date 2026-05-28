import { encodeFunctionData } from "viem";

import type { ifs } from "../../../lib";
import type { WalletContext } from "../../types";

import oracleEmitterJson from "../../../contracts/out/OracleEmitter.sol/OracleEmitter.json";
import erc1967ProxyJson from "../../../contracts/out/ERC1967Proxy.sol/ERC1967Proxy.json";

export type DeployParams = WalletContext & {
  wormholeCore: `0x${string}`;
};

export type DeployResult = {
  implAddress: string;
  proxyAddress: string;
  ownerAddress: string;
  wormholeCore: string;
};

export async function deploy(params: DeployParams): Promise<DeployResult> {
  const { publicClient, walletClient, account, wormholeCore } = params;
  const { abi, bytecode } = oracleEmitterJson as ifs.ContractArtifact;

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

  const initData = encodeFunctionData({
    abi,
    functionName: "initialize",
    args: [wormholeCore],
  });

  const { abi: proxyAbi, bytecode: proxyBytecode } = erc1967ProxyJson as ifs.ContractArtifact;
  const proxyHash = await walletClient.deployContract({
    abi: proxyAbi,
    bytecode: proxyBytecode.object,
    args: [implAddress, initData],
  });
  const proxyReceipt = await publicClient.waitForTransactionReceipt({ hash: proxyHash });
  if (!proxyReceipt.contractAddress) {
    throw new Error("Proxy deployment failed — no contract address.");
  }

  return {
    implAddress,
    proxyAddress: proxyReceipt.contractAddress,
    ownerAddress: account.address,
    wormholeCore,
  };
}
