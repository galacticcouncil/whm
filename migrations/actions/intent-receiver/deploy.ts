import { encodeFunctionData } from "viem";

import type { ifs } from "@whm/common/evm";
import type { WalletContext } from "../types";

import intentReceiverJson from "../../../contracts/out/IntentReceiver.sol/IntentReceiver.json";
import erc1967ProxyJson from "../../../contracts/out/ERC1967Proxy.sol/ERC1967Proxy.json";

export type DeployParams = WalletContext & {
  tokenBridge: `0x${string}`; // Wormhole TokenBridge on this chain
  wrappedNative: `0x${string}`; // canonical wrapped-native (e.g. WETH) unwrapped to native on delivery
  proxy?: `0x${string}`; // when set, upgrade this existing proxy instead of deploying a new one
};

export type DeployResult = {
  implAddress: string;
  proxyAddress: string;
  ownerAddress: string;
};

export async function deploy(params: DeployParams): Promise<DeployResult> {
  const { publicClient, walletClient, account, tokenBridge, wrappedNative, proxy } = params;
  const { abi, bytecode } = intentReceiverJson as ifs.ContractArtifact;

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
    };
  }

  const initializeData = encodeFunctionData({
    abi,
    functionName: "initialize",
    args: [tokenBridge, wrappedNative],
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
