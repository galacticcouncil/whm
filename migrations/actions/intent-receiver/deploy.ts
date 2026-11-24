import { encodeFunctionData } from "viem";

import type { ifs } from "@whm/common/evm";
import { forgeArtifact } from "@whm/common/evm/artifacts";
import type { WalletContext } from "../types";

import intentReceiverJson from "../../../contracts/out/IntentReceiver.sol/IntentReceiver.json";

const erc1967ProxyJson = forgeArtifact("ERC1967Proxy");

export type DeployParams = WalletContext & {
  wormhole: `0x${string}`; // Wormhole core bridge on this chain
  transceiver: `0x${string}`; // NTT WormholeTransceiver that delivers the settlement here
  proxy?: `0x${string}`; // when set, upgrade this existing proxy instead of deploying a new one
};

export type DeployResult = {
  implAddress: string;
  proxyAddress: string;
  ownerAddress: string;
};

export async function deploy(params: DeployParams): Promise<DeployResult> {
  const { publicClient, walletClient, account, wormhole, transceiver, proxy } = params;
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
    args: [wormhole, transceiver],
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
  };
}
