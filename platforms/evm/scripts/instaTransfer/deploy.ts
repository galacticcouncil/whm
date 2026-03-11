import "dotenv/config";

import { encodeFunctionData, isAddress } from "viem";

import { args } from "@whm/common";
import { ifs, wallet } from "../../lib";

import instaTransferJson from "../../contracts/out/InstaTransfer.sol/InstaTransfer.json";
import erc1967ProxyJson from "../../contracts/out/ERC1967Proxy.sol/ERC1967Proxy.json";

const { optionalArg, requiredEnv } = args;
const { getWallet } = wallet;

function getConfig() {
  const rpcUrl = requiredEnv("INSTA_TRANSFER_RPC");
  const chainId = requiredEnv("INSTA_TRANSFER_CHAIN_ID");

  const privateKey = requiredEnv("PRIVATE_KEY");

  const proxy = optionalArg("--proxy");
  if (proxy && !isAddress(proxy)) {
    throw new Error("Invalid --proxy address.");
  }

  return {
    rpcUrl,
    chainId: Number(chainId),
    privateKey: privateKey as `0x${string}`,
    proxy: proxy as `0x${string}` | undefined,
  };
}

async function main(): Promise<void> {
  const { rpcUrl, chainId, privateKey, proxy } = getConfig();

  const { publicClient, walletClient, account } = getWallet(rpcUrl, chainId, privateKey);

  const { abi, bytecode } = instaTransferJson as ifs.ContractArtifact;

  const implDeployHash = await walletClient.deployContract({
    abi,
    bytecode: bytecode.object,
    args: [],
  });

  const implDeployReceipt = await publicClient.waitForTransactionReceipt({ hash: implDeployHash });
  if (!implDeployReceipt.contractAddress) {
    throw new Error("Implementation deployment failed! Contract address missing.");
  }
  const implementationAddress = implDeployReceipt.contractAddress;

  if (proxy) {
    const upgradeHash = await walletClient.writeContract({
      address: proxy,
      abi,
      functionName: "upgradeToAndCall",
      args: [implementationAddress, "0x"],
    });

    await publicClient.waitForTransactionReceipt({ hash: upgradeHash });

    console.log("InstaTransfer implementation:", implementationAddress);
    console.log("InstaTransfer proxy:", proxy, "(upgraded)");
  } else {
    const initializeData = encodeFunctionData({
      abi,
      functionName: "initialize",
      args: [],
    });

    const { abi: proxyAbi, bytecode: proxyBytecode } = erc1967ProxyJson as ifs.ContractArtifact;

    const proxyDeployHash = await walletClient.deployContract({
      abi: proxyAbi,
      bytecode: proxyBytecode.object,
      args: [implementationAddress, initializeData],
    });

    const proxyDeployReceipt = await publicClient.waitForTransactionReceipt({
      hash: proxyDeployHash,
    });

    if (!proxyDeployReceipt.contractAddress) {
      throw new Error("Proxy deployment failed! Contract address missing.");
    }

    const instaTransferAddress = proxyDeployReceipt.contractAddress;

    console.log("InstaTransfer implementation:", implementationAddress);
    console.log("InstaTransfer proxy:", instaTransferAddress);
    console.log("InstaTransfer owner:", account.address);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});